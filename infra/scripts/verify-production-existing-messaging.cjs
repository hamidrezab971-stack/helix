// Uses two retained synthetic QA accounts. No registration, database reset,
// account changes, message deletion, or access to other users' conversations.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright')
const base = 'https://helix.localip.ir'
const output = process.env.HELIX_MONITORING_EVIDENCE
assert(output && path.isAbsolute(output))
const fixture = JSON.parse(fs.readFileSync(process.env.HELIX_MESSAGING_CREDENTIALS_FILE ||
 '/root/helix-production-recheck-20261021T155014Z/acceptance/accounts.json', 'utf8'))
assert.equal(fixture.accounts.length, 2)
const secretValues = fixture.accounts.map(x => x.password)
const redact = s => secretValues.reduce((text, secret) => text.split(secret).join('[redacted]'), String(s))
const report = { at: new Date().toISOString(), result: 'FAIL',
 execution: process.env.GITHUB_ACTIONS ? 'external GitHub-hosted Chromium' : 'VPS Chromium through public DNS',
 existingSyntheticAccountsOnly: true, browserErrors: [] }

async function main() {
 const browser = await chromium.launch({ headless: true })
 try {
  const contexts = [], pages = [], observed = [[], []]
  for (let i = 0; i < 2; i++) {
   const account = fixture.accounts[i], context = await browser.newContext()
   const page = await context.newPage(); contexts.push(context); pages.push(page)
   page.on('pageerror', e => report.browserErrors.push(redact(e.message)))
   page.on('websocket', ws => {
    if (new URL(ws.url()).pathname !== '/ws') return
    assert(ws.url().startsWith('wss://'))
    ws.on('framereceived', frame => {
     try { observed[i].push(JSON.parse(frame.payload)) } catch {}
    })
   })
   await page.goto(base)
   await page.locator('#login-username').fill(account.username)
   await page.locator('#login-password').fill(account.password)
   await page.waitForFunction(() => typeof document.querySelector('altcha-widget')?.getState === 'function')
   await page.locator('altcha-widget').evaluate(async widget => {
    if (widget.getState() === 'unverified') await widget.verify()
   })
   await page.getByText('Verification ready.', { exact: true }).waitFor({ timeout: 90000 })
   const loggedIn = page.waitForResponse(r => new URL(r.url()).pathname === '/api/auth/login' && r.request().method() === 'POST')
   await page.getByRole('button', { name: 'Log in', exact: true }).click()
   assert.equal((await loggedIn).status(), 200)
   await page.getByRole('navigation', { name: 'Main navigation' }).waitFor()
   const deadline = Date.now() + 20000
   while (!observed[i].some(x => x.type === 'presence:snapshot') && Date.now() < deadline) await page.waitForTimeout(100)
   assert(observed[i].some(x => x.type === 'presence:snapshot'), 'Authenticated WSS presence missing')
  }
  for (let i = 0; i < 2; i++) {
   const page = pages[i], peer = fixture.accounts[1 - i]
   await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Contacts', exact: true }).click()
   await page.locator('#user-search').fill(peer.username)
   await page.getByRole('button', { name: new RegExp('^@?' + peer.username + '(?:\\s|$)') }).click()
   await page.locator('#message-content').waitFor()
  }
  const text = 'HELIX Phase 21.3 production acceptance ' + Date.now().toString(36)
  const sending = pages[0].waitForResponse(r => /\/api\/conversations\/\d+\/messages$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST')
  await pages[0].locator('#message-content').fill(text)
  await pages[0].getByRole('button', { name: 'Send', exact: true }).click()
  const sent = await sending; assert.equal(sent.status(), 201)
  const message = await sent.json()
  await pages[1].locator('.chat-history li[data-message-id="' + message.id + '"]').waitFor()
  assert(observed[1].some(x => x.type === 'message:new' && x.data.id === message.id))
  report.loginAndCaptcha = true; report.httpsAndAuthenticatedWss = true
  report.messageDeliveredInSecondBrowser = true
  const token = await pages[0].evaluate(() => localStorage.getItem('smooth_access_token'))
  secretValues.push(token)
  const tokenB = await pages[1].evaluate(() => localStorage.getItem('smooth_access_token')); secretValues.push(tokenB)
  const auth = { Authorization: 'Bearer ' + token }
  // A fixed synthetic 2x2 PNG, never a retained user image.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGNUcEhgYGBgYmBgYGBgAAAI6gDEJfpPsQAAAABJRU5ErkJggg==', 'base64')
  const url = base + '/api/conversations/' + message.conversation_id + '/messages/image'
  const photo = await contexts[0].request.post(url, { headers: auth, multipart: {
   file: { name: 'phase213-synthetic.png', mimeType: 'image/png', buffer: png } } })
  assert.equal(photo.status(), 201)
  const attachment = await photo.json()
  await pages[1].locator('.chat-history li[data-message-id="' + attachment.id + '"]').waitFor()
  const downloaded = await contexts[1].request.get(base + '/api/attachments/' + attachment.attachment.id + '/content', {
   headers: { Authorization: 'Bearer ' + tokenB } })
  assert.equal(downloaded.status(), 200); assert.deepEqual(await downloaded.body(), png)
  const invalid = await contexts[0].request.post(url, { headers: auth, multipart: {
   file: { name: 'invalid.png', mimeType: 'image/png', buffer: Buffer.from('invalid synthetic fixture') } } })
  assert.equal(invalid.status(), 422)
  report.attachmentUploadAndRetrieval = true; report.invalidAttachmentRejected = true
  await pages[1].reload()
  await pages[1].getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Contacts', exact: true }).click()
  await pages[1].locator('#user-search').fill(fixture.accounts[0].username)
  await pages[1].locator('.user-row').filter({ hasText: '@' + fixture.accounts[0].username }).click()
  await pages[1].locator('.chat-history li[data-message-id="' + message.id + '"]').waitFor()
  report.historyAfterRefresh = true
  assert.deepEqual(report.browserErrors, []); report.result = 'PASS'
  for (const c of contexts) await c.close()
 } finally {
  fs.mkdirSync(output, { recursive: true, mode: 0o700 })
  fs.writeFileSync(output + '/messaging-browser.json', redact(JSON.stringify(report, null, 2)) + '\n', { mode: 0o600 })
  await browser.close()
 }
 console.log(JSON.stringify(report))
}
main().catch(e => { console.error(redact(e.message)); process.exitCode = 1 })
