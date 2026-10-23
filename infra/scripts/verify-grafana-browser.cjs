// Authenticated production acceptance. Credentials are read from protected files;
// never save browser storage, HAR, traces, login requests or credential values.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const https = require('node:https')
const path = require('node:path')
const { chromium } = require('playwright')
const origin = 'https://helix.localip.ir'
const root = path.resolve(__dirname, '../..')
const output = process.env.HELIX_GRAFANA_EVIDENCE
assert(output && path.isAbsolute(output), 'Private evidence directory is required')
assert(!output.startsWith(root + '/'), 'Evidence must stay outside Git')
const readSecret = name => fs.readFileSync(process.env[name], 'utf8').trim()

async function main() {
  const browser = await chromium.launch({ headless: true,
    args: ['--host-resolver-rules=MAP helix.localip.ir 127.0.0.1'] })
  const report = { origin, startedAt: new Date().toISOString(), chromium: browser.version(),
    tlsErrorsIgnored: false, access: 'administrator loopback path; edge Basic auth and Grafana session',
    dashboards: [], browserErrors: [], failedRequests: [], failedResponses: [] }
  try {
    const edgePassword = readSecret('HELIX_MONITORING_PASSWORD_FILE')
    const context = await browser.newContext({ viewport: { width: 1440, height: 4000 },
      httpCredentials: { username: 'helix-monitoring', password: edgePassword, origin } })
    // Access rules must still require the edge password from an allowed source.
    const denied = await new Promise((resolve, reject) => {
      https.get(origin + '/grafana/', { family: 4,
        lookup: (_host, _options, callback) => callback(null, '127.0.0.1', 4) },
        response => { response.resume(); resolve(response.statusCode) }).on('error', reject)
    })
    assert.equal(denied, 401)
    const page = await context.newPage()
    page.on('pageerror', error => report.browserErrors.push(error.message))
    page.on('requestfailed', request => report.failedRequests.push({
      path: new URL(request.url()).pathname, error: request.failure()?.errorText }))
    page.on('response', response => {
      const url = new URL(response.url())
      if (url.origin === origin && response.status() >= 400) {
        report.failedResponses.push({ path: url.pathname, status: response.status() })
      }
    })
    const loginPage = await page.goto(origin + '/grafana/login')
    assert.equal(loginPage.status(), 200)
    const server = await loginPage.serverAddr()
    assert.equal(server.ipAddress, '127.0.0.1')
    report.httpsServer = server
    await page.locator('input[name="user"]').fill('helix-admin')
    await page.locator('input[name="password"]').fill(readSecret('HELIX_GRAFANA_PASSWORD_FILE'))
    await page.locator('button[type="submit"]').click()
    await page.waitForURL(url => !url.pathname.endsWith('/login'), { timeout: 30000 })
    const get = async url => page.evaluate(async url => {
      const response = await fetch(url)
      return { status: response.status, data: await response.json() }
    }, url)
    const userResponse = await get(origin + '/grafana/api/user')
    assert.equal(userResponse.status, 200)
    const user = userResponse.data
    assert.equal(user.login, 'helix-admin')
    assert.equal(user.isGrafanaAdmin, true)
    const cookies = await context.cookies(origin + '/grafana/')
    const session = cookies.find(cookie => cookie.name === 'grafana_session')
    assert(session && session.secure && session.httpOnly && session.sameSite === 'Lax')
    assert(session.path.startsWith('/grafana'))
    report.session = { secure: session.secure, httpOnly: session.httpOnly,
      sameSite: session.sameSite, path: session.path, administrator: true }
    const pluginResponse = await get(origin + '/grafana/api/plugins/prometheus/settings')
    assert.equal(pluginResponse.status, 200)
    const plugin = pluginResponse.data
    assert.equal(plugin.signature, 'valid')
    assert.equal(plugin.signatureType, 'grafana')
    report.prometheusPlugin = { signature: plugin.signature, signatureType: plugin.signatureType,
      version: plugin.info.version }

    for (const name of ['services', 'infrastructure', 'application']) {
      const dashboard = JSON.parse(fs.readFileSync(root + '/infra/grafana/dashboards/' + name + '.json'))
      const expected = dashboard.panels.flatMap(panel => panel.targets.map(target => ({
        expression: target.expr, allowEmpty: panel.title === 'Active alerts' })))
      const seen = new Map()
      const pending = new Set()
      const listener = response => {
        if (new URL(response.url()).pathname !== '/grafana/api/ds/query') return
        const promise = (async () => {
          const request = response.request().postDataJSON()
          const data = await response.json()
          for (const query of request.queries) {
            const result = data.results?.[query.refId]
            if (response.status() !== 200 || !result || result.error || (result.status && result.status !== 200)) continue
            const frames = result.frames || []
            const numeric = frames.flatMap(frame => frame.schema.fields.flatMap((field, index) =>
              field.type === 'number' ? frame.data.values[index].filter(value => value !== null) : []))
            if (!numeric.every(value => typeof value === 'number' && Number.isFinite(value))) continue
            seen.set(query.expr, { frames: frames.length, finiteValues: numeric.length })
          }
        })().catch(error => report.browserErrors.push(error.message))
        pending.add(promise)
        promise.finally(() => pending.delete(promise))
      }
      page.on('response', listener)
      try {
        await page.goto(origin + '/grafana/d/' + dashboard.uid + '?from=now-15m&to=now&refresh=30s')
        for (let i = 0; i < 300; i++) {
          if (expected.every(query => seen.has(query.expression) &&
              (query.allowEmpty || seen.get(query.expression).finiteValues > 0))) break
          await page.waitForTimeout(200)
        }
        await Promise.all([...pending])
        for (const query of expected) {
          assert(seen.has(query.expression), name + ': missing successful browser query: ' + query.expression)
          assert(query.allowEmpty || seen.get(query.expression).finiteValues > 0,
            name + ': no finite browser observation: ' + query.expression)
        }
        for (const panel of dashboard.panels) {
          await page.getByTestId('data-testid Panel header ' + panel.title).waitFor({ state: 'visible' })
        }
        await page.screenshot({ path: output + '/grafana-' + name + '.png', fullPage: true })
        report.dashboards.push({ name, uid: dashboard.uid, panels: dashboard.panels.length,
          queries: expected.length, visiblePanelTitles: dashboard.panels.map(panel => panel.title),
          browserQueries: expected.map(query => ({ expression: query.expression, ...seen.get(query.expression) })) })
      } finally { page.off('response', listener) }
    }
    report.live = await page.evaluate(() => new Promise((resolve, reject) => {
      const ws = new WebSocket('wss://helix.localip.ir/grafana/api/live/ws')
      const timer = setTimeout(() => { ws.close(); reject(new Error('Grafana Live timeout')) }, 15000)
      ws.onopen = () => ws.send(JSON.stringify({ id: 1, connect: {} }))
      ws.onmessage = event => {
        const data = JSON.parse(event.data)
        if (data.id === 1 && data.connect) {
          clearTimeout(timer); ws.close(); resolve({ websocketConnected: true, protocolConnected: true })
        } else if (data.error) { clearTimeout(timer); ws.close(); reject(new Error('Grafana Live protocol error')) }
      }
      ws.onerror = () => { clearTimeout(timer); reject(new Error('Grafana Live websocket error')) }
    }))
    assert.equal(report.dashboards.reduce((sum, d) => sum + d.panels, 0), 26)
    assert.equal(report.dashboards.reduce((sum, d) => sum + d.queries, 0), 30)
    assert.deepEqual(report.browserErrors, [])
    assert.deepEqual(report.failedResponses, [])
    report.result = 'PASS'
    await context.close()
  } finally {
    report.completedAt = new Date().toISOString()
    fs.writeFileSync(output + '/browser-acceptance.json', JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
    await browser.close()
  }
  console.log(JSON.stringify({ result: report.result, dashboards: report.dashboards.length,
    panels: 26, queries: 30, live: report.live, secureSession: report.session }))
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
