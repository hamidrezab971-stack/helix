const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { observe, captureFailure, redact } = require('./browser-diagnostics.cjs')

test('Failure diagnostics redact credentials and never record response bodies, headers or queries', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature'
  assert.ok(!redact(`Bearer private-token ${jwt} password123`).includes('private-token'))
  assert.ok(!redact(jwt).includes(jwt))
  let response
  observe({ on: (name, callback) => { assert.equal(name, 'response'); response = callback } })
  response({ url: () => 'http://127.0.0.1/api/conversations?token=private',
    request: () => ({ method: () => 'GET' }), status: () => 200,
    body: () => assert.fail('bodies must not be read'), allHeaders: () => assert.fail('headers must not be read') })
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
        callback({ url: () => 'http://127.0.0.1/api/conversations?token=secret',
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
