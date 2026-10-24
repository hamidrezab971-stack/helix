// Real Chromium over public DNS/TLS. No resolver overrides, ignored TLS errors,
// credential-bearing screenshots, HAR, traces, or persisted browser sessions.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const { chromium, devices } = require('playwright')
const origin = 'https://helix.localip.ir'
const root = path.resolve(__dirname, '../..')
const output = process.env.HELIX_MONITORING_EVIDENCE
assert(output && path.isAbsolute(output) && !output.startsWith(root + '/'))
const credentials = process.env.HELIX_MONITORING_CREDENTIALS_FILE
  ? JSON.parse(fs.readFileSync(process.env.HELIX_MONITORING_CREDENTIALS_FILE, 'utf8'))
  : Object.fromEntries(['administrator', 'stakeholder'].map(role => [role,
    JSON.parse(fs.readFileSync('/etc/helix/monitoring-handoff/' + role + '.json', 'utf8'))]))
const secrets = Object.values(credentials).flatMap(x => [x.edge.password, x.grafana.password])
const redact = message => secrets.reduce((s, value) => s.split(value).join('[redacted]'), String(message))
const report = { startedAt: new Date().toISOString(), origin, result: 'FAIL',
  execution: process.env.GITHUB_ACTIONS ? 'external GitHub-hosted runner' : 'production VPS via public DNS',
  tlsErrorsIgnored: false, browserErrors: [], failedAssets: [], roles: [] }
fs.mkdirSync(output, { recursive: true, mode: 0o700 })

async function main() {
 const browser = await chromium.launch({ headless: true })
 report.chromium = browser.version()
 let canaryContext
 const canaryUid = 'helix-authz-' + Date.now().toString(36)
 let canarySource
 try {
  const anonymous = await browser.newContext()
  const app = await anonymous.newPage()
  app.on('pageerror', e => report.browserErrors.push(redact(e.message)))
  assert.equal((await app.goto(origin)).status(), 200)
  await app.locator('input[type="password"]').waitFor()
  assert.deepEqual(await (await anonymous.request.get(origin + '/api/health')).json(), { status: 'ok' })
  report.application = { loginFormRendered: true, health: 'ok' }
  for (const p of ['/grafana/', '/grafana/login', '/grafana/api/user', '/grafana/api/live/ws',
    '/prometheus/', '/prometheus/api/v1/query?query=up', '/monitoring/']) {
   assert.equal((await anonymous.request.get(origin + p)).status(), 401, p)
   assert.equal((await anonymous.request.get(origin + p, { headers: {
    Authorization: 'Basic ' + Buffer.from('invalid:invalid').toString('base64'),
    'X-Forwarded-For': '127.0.0.1' } })).status(), 401, p)
  }
  for (const p of ['/metrics', '/internal/metrics', '/prometheus/metrics', '/prometheus/federate',
    '/prometheus/-/reload', '/prometheus/api/v1/admin/tsdb/delete_series']) {
   assert.equal((await anonymous.request.get(origin + p)).status(), 404, p)
  }
  const redirect = await anonymous.request.get('http://helix.localip.ir/grafana/', { maxRedirects: 0 })
  assert.equal(redirect.status(), 308); assert.equal(redirect.headers().location, origin + '/grafana/')
  report.anonymousAndInvalidDenied = true
  report.privatePorts = await Promise.all([13000, 19090, 19100, 9090, 3000, 9100, 18000].map(port =>
   new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: 'helix.localip.ir', port })
    socket.setTimeout(2500)
    socket.on('connect', () => { socket.destroy(); reject(new Error('Public internal port reachable: ' + port)) })
    socket.on('timeout', () => { socket.destroy(); resolve({ port, reachable: false }) })
    socket.on('error', () => resolve({ port, reachable: false }))
   })))
  await anonymous.close()
  canaryContext = await browser.newContext({ httpCredentials: { ...credentials.administrator.edge, origin } })
  assert.equal((await canaryContext.request.post(origin + '/grafana/login', { data: {
   user: credentials.administrator.grafana.username, password: credentials.administrator.grafana.password } })).status(), 200)
  assert.equal((await canaryContext.request.post(origin + '/grafana/api/dashboards/db', { data: {
   dashboard: { uid: canaryUid, title: 'Temporary authorization acceptance', panels: [], schemaVersion: 41 }, overwrite: false } })).status(), 200)
  const source = await canaryContext.request.post(origin + '/grafana/api/datasources', { data: {
   uid: canaryUid, name: canaryUid, type: 'prometheus', access: 'proxy', url: 'http://prometheus:9090' } })
  assert.equal(source.status(), 200); canarySource = true

  async function verifyRole(role, mobile = false) {
   const c = credentials[role]
   const context = await browser.newContext({ ...(mobile ? devices['Pixel 7'] : { viewport: { width: 1440, height: 4000 } }),
    httpCredentials: { ...c.edge, origin } })
   const result = { role, mobile, dashboards: [], assetResponses: 0 }
   const page = await context.newPage()
   page.on('pageerror', e => report.browserErrors.push(redact(e.message)))
   page.on('response', response => {
    const u = new URL(response.url())
    if (u.pathname.startsWith('/grafana/public/') && /\.(js|css)(\?|$)/.test(u.pathname)) {
     result.assetResponses++
     if (response.status() !== 200) report.failedAssets.push({ path: u.pathname, status: response.status() })
    }
   })
   const login = async () => {
    await page.goto(origin + '/grafana/login')
    await page.locator('input[name="user"]').fill(c.grafana.username)
    await page.locator('input[name="password"]').fill(c.grafana.password)
    await page.locator('button[type="submit"]').click()
    await page.waitForURL(u => !u.pathname.endsWith('/login'), { timeout: 45000 })
   }
   const get = async (url, options) => {
    const r = await page.evaluate(async ({ url, options }) => {
     const r = await fetch(url, options); return { status: r.status, data: await r.json() }
    }, { url, options }); return r
   }
   assert.equal((await context.request.get(origin + '/grafana/api/user')).status(), 401)
   assert.equal((await context.request.post(origin + '/grafana/login', { data: {
    user: 'phase213-invalid-user', password: 'deliberately-invalid-phase213-password' } })).status(), 401)
   await login()
   const user = await get('/grafana/api/user')
   assert.equal(user.status, 200); assert.equal(user.data.login, c.grafana.username)
   assert.equal(user.data.isGrafanaAdmin, role === 'administrator')
   const orgs = await get('/grafana/api/user/orgs')
   assert.equal(orgs.status, 200)
   const orgRole = orgs.data.find(x => x.orgId === user.data.orgId)?.role
   assert.equal(orgRole, role === 'administrator' ? 'Admin' : 'Viewer')
   result.nativeRole = orgRole
   const cookies = await context.cookies(origin + '/grafana/')
   const session = cookies.find(x => x.name === 'grafana_session')
   assert(session && session.secure && session.httpOnly && session.sameSite === 'Lax' && session.path === '/grafana')
   result.session = { secure: session.secure, httpOnly: session.httpOnly, sameSite: session.sameSite, path: session.path }
   const permissions = await get('/grafana/api/access-control/user/permissions')
   assert.equal(permissions.status, 200)
   if (role === 'stakeholder') {
    for (const action of ['dashboards:write', 'dashboards:delete', 'datasources:write', 'org.users:write',
      'users:write', 'alert.rules:write', 'alert.rules:delete']) assert(!permissions.data[action], action)
    for (const url of ['/grafana/api/users', '/grafana/api/admin/settings']) {
     assert.equal((await get(url)).status, 403, url)
    }
    // Temporary administrator-created objects exercise real authorization without
    // putting the three approved dashboards or production datasource at risk.
    const dashboard = await get('/grafana/api/dashboards/uid/helix-services')
    assert.equal(dashboard.status, 200); assert.equal(dashboard.data.meta.canEdit, false)
    assert.equal(dashboard.data.meta.canSave, false); assert.equal(dashboard.data.meta.canAdmin, false)
    for (const [url, method] of [['/grafana/api/dashboards/uid/' + canaryUid, 'DELETE'],
      ['/grafana/api/datasources/uid/' + canaryUid, 'PUT'],
      ['/grafana/api/admin/users', 'POST'], ['/grafana/api/v1/provisioning/alert-rules', 'POST']]) {
     const r = await get(url, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'DELETE' ? undefined : '{}' })
     assert.equal(r.status, 403, method + ' ' + url)
    }
    assert.equal((await context.request.get(origin + '/prometheus/')).status(), 401)
    assert.equal((await context.request.get(origin + '/prometheus/api/v1/query?query=up')).status(), 401)
    for (const url of [
     '/grafana/api/datasources/proxy/uid/helix-prometheus/api/v1/status/config',
     '/grafana/api/datasources/proxy/uid/helix-prometheus/metrics',
     '/grafana/api/datasources/uid/helix-prometheus/resources/api/v1/status/config',
     '/grafana/api/datasources/uid/helix-prometheus/resources/api/v1/status/runtimeinfo',
     '/grafana/api/datasources/uid/helix-prometheus/resources/metrics',
     '/grafana/api/datasources/uid/helix-prometheus/resources/api/v1/targets',
     '/grafana/api/datasources/uid/helix-prometheus/resources/%61pi/v1/status/config',
     '/grafana/api/datasources/uid/helix-prometheus/resources/api/v1/../v1/status/config']) {
     assert.equal((await context.request.get(origin + url)).status(), 404, url)
    }
    result.datasourceProxyCannotBypassPrometheusAdminBoundary = true
    result.forbiddenOperationsDenied = true
   } else {
    assert.equal((await get('/grafana/api/users')).status, 200)
    const source = await get('/grafana/api/datasources/uid/helix-prometheus')
    assert.equal(source.status, 200); assert.equal(source.data.url, 'http://prometheus:9090')
    assert.equal(source.data.access, 'proxy'); result.privateDatasource = source.data.url
    const plugin = await get('/grafana/api/plugins/prometheus/settings')
    assert.equal(plugin.status, 200); assert.equal(plugin.data.signature, 'valid')
    assert.equal(plugin.data.signatureType, 'grafana')
    result.prometheusPluginSignature = { signature: plugin.data.signature, type: plugin.data.signatureType }
    const p = await context.newPage()
    p.on('pageerror', e => report.browserErrors.push(redact(e.message)))
    for (const route of ['query', 'targets', 'status']) {
     assert.equal((await p.goto(origin + '/prometheus/' + route)).status(), 200)
     await p.locator('#root').waitFor()
     await p.waitForTimeout(1000)
     assert((await p.locator('body').innerText()).includes('Prometheus'))
     if (route === 'targets') {
      assert((await p.locator('body').innerText()).includes('Target health'))
      const targets = await context.request.get(origin + '/prometheus/api/v1/targets')
      const data = await targets.json()
      assert.equal(data.data.activeTargets.length, 3)
      assert(data.data.activeTargets.every(x => x.health === 'up' && !x.lastError))
     }
     if (route === 'status') assert((await p.locator('body').innerText()).includes('Runtime & build information'))
    }
    await p.goto(origin + '/prometheus/query')
    const editor = p.locator('.cm-content[contenteditable="true"]')
    await editor.waitFor(); await editor.fill('up')
    const queryResponse = p.waitForResponse(r => {
     const url = new URL(r.url())
     return url.pathname === '/prometheus/api/v1/query' && url.searchParams.get('query') === 'up' && r.status() === 200
    })
    await p.getByRole('button', { name: 'Execute', exact: true }).click()
    const queried = await (await queryResponse).json()
    assert.equal(queried.status, 'success'); assert.equal(queried.data.result.length, 3)
    assert(queried.data.result.every(x => x.value[1] === '1'))
    result.prometheus = { queryBrowserExecuted: true, targets: 3, pagesRendered: ['query', 'targets', 'status'] }
    await p.close()
   }
   const names = ['services', 'infrastructure', 'application']
   for (const name of names) {
    const d = JSON.parse(fs.readFileSync(root + '/infra/grafana/dashboards/' + name + '.json'))
    const expected = d.panels.flatMap(p => p.targets.map(t => ({ expression: t.expr, allowEmpty: p.title === 'Active alerts' })))
    const seen = new Map(), pending = new Set()
    const listener = response => {
     if (new URL(response.url()).pathname !== '/grafana/api/ds/query') return
     const promise = (async () => {
      const payload = response.request().postDataJSON(), body = await response.json()
      for (const query of payload.queries) {
       const data = body.results?.[query.refId]
       if (response.status() !== 200 || !data || data.error || (data.status && data.status !== 200)) continue
       const numeric = (data.frames || []).flatMap(f => f.schema.fields.flatMap((field, i) =>
        field.type === 'number' ? f.data.values[i].filter(x => x !== null) : []))
       if (numeric.every(x => typeof x === 'number' && Number.isFinite(x))) seen.set(query.expr, { finiteValues: numeric.length })
      }
     })().catch(e => report.browserErrors.push(redact(e.message)))
     pending.add(promise); promise.finally(() => pending.delete(promise))
    }
    page.on('response', listener)
    try {
     await page.goto(origin + '/grafana/d/' + d.uid + '?from=now-15m&to=now&refresh=30s')
     for (const panel of d.panels) {
      const header = page.getByTestId('data-testid Panel header ' + panel.title)
      await header.scrollIntoViewIfNeeded(); await header.waitFor({ state: 'visible' })
     }
     for (let i = 0; i < 300; i++) {
      if (expected.every(x => seen.has(x.expression) && (x.allowEmpty || seen.get(x.expression).finiteValues > 0))) break
      await page.waitForTimeout(200)
     }
     await Promise.all([...pending])
     for (const x of expected) {
      assert(seen.has(x.expression), name + ' missing query: ' + x.expression)
      assert(x.allowEmpty || seen.get(x.expression).finiteValues > 0, name + ' no finite values: ' + x.expression)
     }
     seen.clear()
     await page.reload()
     await page.getByTestId('data-testid Panel header ' + d.panels[0].title).waitFor()
     for (const panel of d.panels) await page.getByTestId('data-testid Panel header ' + panel.title).scrollIntoViewIfNeeded()
     for (let i = 0; i < 300; i++) {
      if (expected.every(x => seen.has(x.expression) && (x.allowEmpty || seen.get(x.expression).finiteValues > 0))) break
      await page.waitForTimeout(200)
     }
     await Promise.all([...pending])
     for (const x of expected) {
      assert(seen.has(x.expression) && (x.allowEmpty || seen.get(x.expression).finiteValues > 0), name + ' refresh query did not render: ' + x.expression)
     }
     result.dashboards.push({ name, uid: d.uid, panels: d.panels.length, queries: expected.length,
      refreshPassed: true, browserQueries: expected.map(x => ({ expression: x.expression, ...seen.get(x.expression) })) })
     if (!mobile) await page.screenshot({ path: output + '/' + role + '-' + name + '.png', fullPage: true })
    } finally { page.off('response', listener) }
   }
   result.live = await page.evaluate(() => new Promise((resolve, reject) => {
    const ws = new WebSocket('wss://helix.localip.ir/grafana/api/live/ws')
    const timer = setTimeout(() => { ws.close(); reject(new Error('Grafana Live timeout')) }, 15000)
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, connect: {} }))
    ws.onmessage = e => {
     const data = JSON.parse(e.data)
     if (data.id === 1 && data.connect) { clearTimeout(timer); ws.close(); resolve({ websocketConnected: true, protocolConnected: true }) }
     else if (data.error) { clearTimeout(timer); ws.close(); reject(new Error('Live protocol error')) }
    }
    ws.onerror = () => { clearTimeout(timer); reject(new Error('Live websocket error')) }
   }))
   // Revoke on the server, then replay the old session to verify re-login is required.
   await page.goto(origin + '/grafana/logout')
   await context.clearCookies(); await context.addCookies(cookies)
   assert.equal((await context.request.get(origin + '/grafana/api/user')).status(), 401)
   await page.goto(origin + '/grafana/d/helix-services')
   await page.waitForURL(u => u.pathname.endsWith('/login'))
   await login(); assert.equal((await get('/grafana/api/user')).status, 200)
   result.revokedSessionDeniedAndReloginPassed = true
   if (role === 'stakeholder' && !mobile) {
    // Stop the previous SPA's session poller before expiring the browser cookie;
    // its own login redirect must not race a new explicit navigation.
    await page.goto('about:blank')
    const expired = (await context.cookies(origin + '/grafana/')).find(x => x.name === 'grafana_session')
    await context.addCookies([{ ...expired, expires: Math.floor(Date.now() / 1000) - 10 }])
    assert(!(await context.cookies(origin + '/grafana/')).some(x => x.name === 'grafana_session'))
    assert.equal((await context.request.get(origin + '/grafana/api/user')).status(), 401)
    await page.goto(origin + '/grafana/d/helix-services')
    await page.waitForURL(u => u.pathname.endsWith('/login'))
    await login(); assert.equal((await get('/grafana/api/user')).status, 200)
    result.browserCookieExpiryDeniedAndReloginPassed = true
   }
   assert(result.assetResponses > 0)
   report.roles.push(result); await context.close()
  }
  await verifyRole('stakeholder')
  await verifyRole('administrator')
  await verifyRole('stakeholder', true)
  for (const role of report.roles) {
   assert.equal(role.dashboards.reduce((n, d) => n + d.panels, 0), 26)
   assert.equal(role.dashboards.reduce((n, d) => n + d.queries, 0), 30)
  }
  assert.deepEqual(report.browserErrors, []); assert.deepEqual(report.failedAssets, [])
  report.result = 'PASS'
 } finally {
  if (canaryContext) {
   await canaryContext.request.delete(origin + '/grafana/api/dashboards/uid/' + canaryUid)
   if (canarySource) await canaryContext.request.delete(origin + '/grafana/api/datasources/uid/' + canaryUid)
   await canaryContext.close()
  }
  report.completedAt = new Date().toISOString()
  fs.writeFileSync(output + '/monitoring-browser.json', redact(JSON.stringify(report, null, 2)) + '\n', { mode: 0o600 })
  await browser.close()
 }
 console.log(JSON.stringify({ result: report.result, execution: report.execution, chromium: report.chromium,
  roles: report.roles.map(x => ({ role: x.role, mobile: x.mobile, dashboards: x.dashboards.length, live: x.live })) }))
}
main().catch(error => { console.error(redact(error.stack)); process.exitCode = 1 })
