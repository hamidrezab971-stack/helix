const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { observe, captureFailure, redact, redactStream } = require('./browser-diagnostics.cjs')

test('Subprocess diagnostics mask credentials even when a JWT crosses stream chunks', async () => {
  const { PassThrough, Writable } = require('node:stream')
  const { once } = require('node:events')
  const input = new PassThrough()
  let logged = ''
  const output = new Writable({ write(chunk, encoding, done) { logged += chunk.toString(); done() } })
  const lines = redactStream(input, output)
  const closed = once(lines, 'close')
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature'
  input.write('proxy /sync?after=' + jwt.slice(0, 25))
  input.write(jwt.slice(25) + '\nBearer private-token password123\n')
  input.end()
  await closed
  assert.match(logged, /proxy \/sync\?after=\[redacted JWT\]/)
  assert.ok(!logged.includes(jwt) && !logged.includes('private-token') && !logged.includes('password123'))
})

test('Failure diagnostics redact credentials and observe lifecycle without reading bodies or credentials', async () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature'
  assert.ok(!redact(`Bearer private-token ${jwt} password123`).includes('private-token'))
  assert.ok(!redact(jwt).includes(jwt))
  const handlers = {}, page = { on: (name, callback) => { handlers[name] = callback } }
  observe(page)
  const request = { method: () => 'GET', failure: () => ({ errorText: 'net::ERR_ABORTED' }) }
  handlers.response({ url: () => 'http://127.0.0.1/api/conversations?token=private',
    request: () => request, status: () => 200,
    headers: () => ({ 'content-type': 'application/json', 'content-length': '123', 'set-cookie': 'private-cookie', authorization: 'Bearer private-token' }),
    body: () => assert.fail('bodies must not be read'), allHeaders: () => assert.fail('headers must not be read') })
  handlers.requestfailed(request)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostics-lifecycle-'))
  const saved = process.env.HELIX_BROWSER_ARTIFACTS
  process.env.HELIX_BROWSER_ARTIFACTS = root
  page.evaluate = async () => { throw new Error('closed fixture') }
  try {
    const directory = await captureFailure({ version: () => 'fixture', contexts: () => [{ pages: () => [page] }] }, new Error('fixture'))
    const report = JSON.parse(fs.readFileSync(path.join(directory, 'failure.json')))
    const entry = report.pages[0].responses[0]
    assert.equal(entry.path, '/api/conversations')
    assert.equal(entry.lifecycle, 'requestfailed')
    assert.equal(entry.failure, 'net::ERR_ABORTED')
    assert.deepEqual(entry.headers, { 'content-type': 'application/json', 'content-length': '123' })
    assert.ok(!JSON.stringify(report).includes('private'))
  } finally {
    if (saved === undefined) delete process.env.HELIX_BROWSER_ARTIFACTS
    else process.env.HELIX_BROWSER_ARTIFACTS = saved
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Failure evidence survives browser cleanup, masks inputs and strips secrets from the report', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostics-unit-'))
  const saved = process.env.HELIX_BROWSER_ARTIFACTS
  process.env.HELIX_BROWSER_ARTIFACTS = root
  try {
    const page = { evaluate: async () => ({ dom: '<body>password123</body>', rows: [] }), locator: value => value,
      screenshot: async options => {
        assert.deepEqual(options.mask, ['input,textarea,altcha-widget'])
        fs.writeFileSync(options.path, 'fixture image')
      }, on: (name, callback) => {
        if (name !== 'response') return
        callback({ url: () => 'http://127.0.0.1/api/conversations?token=secret', headers: () => ({}),
          request: () => ({ method: () => 'GET' }), status: () => 503 })
      } }
    observe(page)
    const directory = await captureFailure({ version: () => 'fixture', contexts: () => [{ pages: () => [page] }] }, new Error('Bearer secret'))
    const report = fs.readFileSync(path.join(directory, 'failure.json'), 'utf8')
    assert.ok(!report.includes('secret'))
    assert.equal(JSON.parse(report).pages[0].responses[0].path, '/api/conversations')
    assert.ok(!fs.readFileSync(path.join(directory, 'page-0.html'), 'utf8').includes('password123'))
    assert.equal(fs.statSync(path.join(directory, 'failure.json')).mode & 0o777, 0o600)
  } finally {
    if (saved === undefined) delete process.env.HELIX_BROWSER_ARTIFACTS
    else process.env.HELIX_BROWSER_ARTIFACTS = saved
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('A failed or closed page records the capture error without losing the original failure', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostics-unit-'))
  const saved = process.env.HELIX_BROWSER_ARTIFACTS
  process.env.HELIX_BROWSER_ARTIFACTS = root
  try {
    const directory = await captureFailure({ version: () => 'fixture', contexts: () => [{ pages: () => [
      { evaluate: async () => { throw new Error('page closed') } },
    ] }] }, new Error('original assertion'))
    const report = JSON.parse(fs.readFileSync(path.join(directory, 'failure.json')))
    assert.match(report.error, /original assertion/)
    assert.equal(report.pages[0].captureError, 'page closed')
  } finally {
    if (saved === undefined) delete process.env.HELIX_BROWSER_ARTIFACTS
    else process.env.HELIX_BROWSER_ARTIFACTS = saved
    fs.rmSync(root, { recursive: true, force: true })
  }
})
