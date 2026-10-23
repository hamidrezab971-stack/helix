// Read-only public acceptance, also run from an independent GitHub-hosted runner.
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const origin = 'https://helix.localip.ir'

async function main() {
  const browser = await chromium.launch({ headless: true })
  try {
    const context = await browser.newContext()
    const page = await context.newPage()
    const errors = []
    const failedRequests = []
    const failedAssets = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('requestfailed', request => failedRequests.push({
      path: new URL(request.url()).pathname, error: request.failure()?.errorText,
    }))
    page.on('response', response => {
      const url = new URL(response.url())
      if (url.pathname.startsWith('/assets/') && response.status() !== 200) {
        failedAssets.push({ path: url.pathname, status: response.status() })
      }
    })
    const response = await page.goto(origin + '/', { waitUntil: 'networkidle', timeout: 45000 })
    assert.equal(response.status(), 200)
    try {
      await page.locator('#root').waitFor()
      await page.locator('input[type="password"]').waitFor()
    } catch (error) {
      console.error(JSON.stringify({ browserErrors: errors, failedRequests, failedAssets }))
      throw error
    }
    assert.equal(new URL(page.url()).origin, origin)
    const scripts = await page.locator('script[src]').evaluateAll(nodes => nodes.map(n => n.src))
    const styles = await page.locator('link[rel="stylesheet"]').evaluateAll(nodes => nodes.map(n => n.href))
    assert(scripts.length > 0 && styles.length > 0)
    for (const url of [...scripts, ...styles]) {
      assert.equal(new URL(url).origin, origin)
      assert.equal((await context.request.get(url)).status(), 200)
    }
    assert.deepEqual(await (await context.request.get(origin + '/api/health')).json(), { status: 'ok' })
    assert.equal((await context.request.get(origin + '/api/auth/me')).status(), 401)
    const denied = ['/grafana', '/grafana/', '/grafana/login', '/grafana/api/live/ws',
      '/grafana/public/build/test.js', '/prometheus', '/prometheus/', '/prometheus/api/v1/query',
      '/internal/metrics', '/metrics', '/.env', '/docs', '/openapi.json']
    const deniedStatuses = {}
    for (const path of denied) {
      const status = (await context.request.get(origin + path)).status()
      // Private administrator routes return 403 to external source addresses;
      // suspended routes and all other protected application paths retain 404.
      assert((path.startsWith('/grafana') ? [403, 404] : [404]).includes(status), path)
      deniedStatuses[path] = status
      assert.equal((await context.request.get(origin + path, {
        headers: { Authorization: 'Basic ' + Buffer.from('unauthorized:invalid').toString('base64'),
          'X-Forwarded-For': '127.0.0.1' },
      })).status(), status, path + ' with untrusted credentials/forwarded header')
    }
    const redirect = await context.request.get('http://helix.localip.ir/grafana/', { maxRedirects: 0 })
    assert.equal(redirect.status(), 308)
    assert.equal(redirect.headers().location, origin + '/grafana/')
    assert.deepEqual(errors, [])
    console.log(JSON.stringify({ origin, chromium: browser.version(), application: 'PASS',
      assets: scripts.length + styles.length, deniedPaths: denied.length,
      anonymousAndUnauthorizedDenied: true, deniedStatuses,
      monitoring: deniedStatuses['/grafana/'] === 403 ? 'PRIVATE ACCESS ONLY' : 'NOT ENABLED', browserErrors: errors }))
  } finally {
    await browser.close()
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
