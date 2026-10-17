// Legacy behavioral coverage, using Phase 18 menus and composer controls.
const { chromium, expect } = require('playwright/test')
const assert = require('node:assert/strict')
const { spawn, execFileSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const assertPortFree = require('./ports.cjs')
const { observe, captureFailure } = require('./browser-diagnostics.cjs')

const backendDirectory = path.resolve(__dirname, '../../backend')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'smooth-phase8-'))
let server, browser
const errors = []
const suffix = Date.now()
const names = { alice: `alice_${suffix}`, bob: `bob_${suffix}`, charlie: `charlie_${suffix}` }

async function startBackend() {
  await assertPortFree(8000)
  server = spawn(path.join(backendDirectory, '.venv/bin/python'), ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8000'], {
    cwd: backendDirectory,
    env: { ...process.env, DATABASE_URL: `sqlite:///${temporary}/test.db`, SECRET_KEY: 'phase8-browser-test-only-secret-123456789', ACCESS_TOKEN_EXPIRE_MINUTES: '60', FRONTEND_ORIGIN: 'http://127.0.0.1:5173', UPLOAD_DIR: `${temporary}/uploads`, FRONTEND_DIST_DIR: '', PYTHON_DOTENV_DISABLED: '1' },
    stdio: backendLog(),
  })
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error('Test backend could not start; port 8000 must be free')
    try { if ((await fetch('http://127.0.0.1:8000/')).ok) return } catch {}
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Backend startup timed out')
}

function backendLog() {
  if (!process.env.HELIX_BROWSER_ARTIFACTS) return 'ignore'
  const directory = path.join(process.env.HELIX_BROWSER_ARTIFACTS, path.basename(process.argv[1], '.cjs'))
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const log = fs.openSync(path.join(directory, 'backend.log'), 'a', 0o600)
  // spawn duplicates these descriptors; close the parent's copy after spawn.
  queueMicrotask(() => fs.closeSync(log))
  console.log(`${new Date().toISOString()} backend start`)
  return ['ignore', log, log]
}

async function stopBackend() {
  if (!server || server.exitCode !== null) return
  console.log(`${new Date().toISOString()} backend stop`)
  const exited = new Promise(resolve => server.once('exit', resolve))
  server.kill('SIGTERM')
  await exited
}

async function presenceBody(page) {
  // Read this dedicated real GET inside Fetch, while its document is alive.
  // The hook aborts its initial refresh when the WS snapshot refreshes again;
  // waitForResponse can select that cancelled request after its 200 headers.
  const result = await page.evaluate(async () => {
    const response = await fetch('/api/users/presence', {
      headers: { Authorization: `Bearer ${localStorage.getItem('smooth_access_token')}` },
      signal: AbortSignal.timeout(5000),
    })
    const headers = {}
    for (const name of ['content-type', 'content-length', 'cache-control', 'date', 'server', 'connection', 'transfer-encoding']) {
      const value = response.headers.get(name)
      if (value !== null) headers[name] = value
    }
    return { status: response.status, headers, body: await response.text() }
  })
  // Never print tokens, bodies, peer identities or message contents.
  console.log('Presence API ' + JSON.stringify({ method: 'GET', path: '/api/users/presence',
    status: result.status, headers: result.headers, lifecycle: 'body consumed by browser Fetch' }))
  assert.equal(result.status, 200)
  assert.match(result.headers['content-type'], /^application\/json\b/)
  const body = JSON.parse(result.body)
  assert.ok(Array.isArray(body.users))
  return body
}

async function withMissingLastSeen(userId, verify) {
  // Seed the disposable DB, so the fallback uses a real API response too.
  // Do not intercept/fulfill the request or change production data.
  const python = path.join(backendDirectory, '.venv/bin/python')
  const database = `${temporary}/test.db`
  const previous = execFileSync(python, ['-c', `import sqlite3,sys,json
db=sqlite3.connect(sys.argv[1])
row=db.execute('SELECT last_seen_at FROM users WHERE id=?',(int(sys.argv[2]),)).fetchone()
assert row is not None and row[0] is not None
assert db.execute('UPDATE users SET last_seen_at=NULL WHERE id=?',(int(sys.argv[2]),)).rowcount==1
db.commit()
print(json.dumps(row[0]))`, database, String(userId)], { encoding: 'utf8' }).trim()
  try { await verify() } finally {
    execFileSync(python, ['-c', `import sqlite3,sys,json
db=sqlite3.connect(sys.argv[1])
assert db.execute('UPDATE users SET last_seen_at=? WHERE id=?',(json.loads(sys.argv[3]),int(sys.argv[2]))).rowcount==1
db.commit()`, database, String(userId), previous])
  }
}

async function newPage(context) {
  const page = await context.newPage()
  observe(page)
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => {
    window.realtimeTest = { authenticated: 0, closed: 0, events: [], received: [], sentTyping: [], statuses: [], mutations: [], cleared: [] }
    window.imageUrls = { created: [], revoked: [] }
    const originalCreate = URL.createObjectURL.bind(URL), originalRevoke = URL.revokeObjectURL.bind(URL)
    URL.createObjectURL = blob => { const url = originalCreate(blob); window.imageUrls.created.push(url); return url }
    URL.revokeObjectURL = url => { window.imageUrls.revoked.push(url); originalRevoke(url) }
    const NativeWebSocket = window.WebSocket
    window.WebSocket = class extends NativeWebSocket {
      constructor(...args) {
        if (window.realtimeTest.pauseRealtime) throw new Error('Realtime paused by regression test')
        super(...args)
        window.realtimeTest.socket = this
        this.addEventListener('close', () => window.realtimeTest.closed++)
        this.addEventListener('message', event => {
          try {
            const data = JSON.parse(event.data)
            if (data.type === 'auth:ok') window.realtimeTest.authenticated++
            if (data.type === 'message:new') window.realtimeTest.events.push(data.data)
            if (data.type === 'message:new' && window.realtimeTest.dropNewMessage) event.stopImmediatePropagation()
            if (data.type === 'message:status') window.realtimeTest.statuses.push(data.data)
            if (data.type === 'message:updated') window.realtimeTest.mutations.push(data.data)
            if (data.type === 'conversation:cleared') window.realtimeTest.cleared.push(data.data)
            if (data.type.startsWith('presence:') || data.type.startsWith('typing:')) window.realtimeTest.received.push(data)
          } catch {}
        })
      }
      send(payload) {
        const data = JSON.parse(payload)
        if (data.type.startsWith('typing:')) {
          window.realtimeTest.sentTyping.push(data)
          if (data.type === 'typing:stop' && window.realtimeTest.dropTypingStop) return
        }
        super.send(payload)
      }
    }
  })
  await page.goto('http://127.0.0.1:5173')
  return page
}

async function registerAndLogin(page, name) {
  await page.getByRole('button', { name: 'Create one' }).click()
  await page.locator('#register-username').fill(name)
  await page.locator('#register-password').fill('password123')
  await page.locator('#register-confirmation').fill('password123')
  await require('./captcha.cjs').ready(page)
  await page.getByRole('button', { name: 'Create account', exact: true }).click()
  await page.locator('#login-password').fill('password123')
  await require('./captcha.cjs').ready(page)
  await page.getByRole('button', { name: 'Log in', exact: true }).click()
  await page.waitForFunction(() => window.realtimeTest.authenticated === 1)
}

async function navigate(page, destination) {
  const nav = page.getByRole('navigation', { name: 'Main navigation' })
  if (!await nav.isVisible()) {
    await page.getByRole('button', { name: 'Back', exact: true }).click()
    await expect(nav).toBeVisible()
  }
  await nav.getByRole('button', { name: destination, exact: true }).click()
  await expect(nav.getByRole('button', { name: destination, exact: true })).toHaveAttribute('aria-current', 'page')
}

async function select(page, name) {
  await navigate(page, 'Contacts')
  await page.locator('#user-search').fill(name)
  await directoryRow(page, name).click()
  await expect(page.locator('#message-content')).toBeEnabled()
  if (!await page.evaluate(() => matchMedia('(max-width: 767px)').matches)) {
    await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Chats', exact: true })).toHaveAttribute('aria-current', 'page')
  }
}

async function directoryPresence(page, name, state) {
  await navigate(page, 'Contacts')
  await page.locator('#user-search').fill(name)
  await expect(directoryRow(page, name)).toContainText(state)
  await navigate(page, 'Chats')
  await recentPresence(page, name, state === 'online')
}

async function logout(page) {
  await navigate(page, 'Profile')
  await page.getByRole('button', { name: 'Log out', exact: true }).click()
}

function directoryRow(page, name) {
  return page.locator('.user-row').filter({ hasText: `@${name}` })
}

function recentRow(page, name) {
  return page.locator('.recent-row').filter({ hasText: `@${name}` })
}

async function recentPresence(page, name, online) {
  const row = recentRow(page, name)
  await expect(row).toHaveCount(1)
  await expect(row.locator('.conversation-name')).toHaveText(`@${name}`)
  // Profile and chat are separate sibling buttons; do not nest buttons to
  // satisfy the legacy descendant locator. Scope the avatar to this list item.
  const item = page.getByRole('listitem').filter({ has: row })
  await expect(item).toHaveCount(1)
  const profile = item.getByRole('button', { name: `View ${name}'s profile`, exact: true })
  await expect(profile).toBeVisible()
  const indicator = profile.locator('.avatar-presence')
  await expect(indicator).toHaveCount(1)
  await expect(indicator).toHaveAttribute('data-online', String(online))
  await expect(indicator).toHaveCSS('opacity', online ? '1' : '0')
}

async function openRecent(page, name) {
  await navigate(page, 'Chats')
  let creates = 0
  const observe = request => { if (request.method() === 'POST' && request.url().includes('/api/conversations/with/')) creates++ }
  page.on('request', observe)
  await recentRow(page, name).click()
  await expect(page.locator('#chat-title')).toHaveText(`@${name}`)
  await expect(page.locator('#message-content')).toBeEnabled()
  page.off('request', observe)
  assert.equal(creates, 0, 'Recent rows must load existing history without a create request')
}

async function send(page, content) {
  await page.locator('#message-content').fill(content)
  const response = page.waitForResponse(r => r.url().endsWith('/messages') && r.request().method() === 'POST')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  const saved = await response
  assert.equal(saved.status(), 201)
  const data = await saved.json()
  assert.equal(data.delivered_at, null)
  assert.equal(data.read_at, null)
  return data
}

async function once(page, content) {
  await expect(page.locator('.message-bubble').filter({ hasText: content })).toHaveCount(1)
}

async function status(page, content, expected) {
  await expect(page.locator('.message-bubble').filter({ hasText: content }).getByLabel('Message status')).toHaveText(expected)
}

async function unread(page, name, count) {
  const badge = recentRow(page, name).locator('[aria-label$=" unread message"], [aria-label$=" unread messages"]')
  if (count === 0) await expect(badge).toHaveCount(0)
  else {
    await expect(badge).toHaveAttribute('aria-label', `${count} unread ${count === 1 ? 'message' : 'messages'}`)
    await expect(badge).toHaveText(count > 99 ? '99+' : String(count))
  }
}

function messageRow(page, content) {
  return page.locator('.chat-history li').filter({ has: page.locator('.message-bubble').filter({ hasText: content }) })
}

async function openMenu(page, row) {
  const existing = page.getByRole('dialog')
  if (await existing.count()) {
    await page.keyboard.press('Escape')
    await expect(existing).toHaveCount(0)
  }
  await row.scrollIntoViewIfNeeded()
  await row.locator('.message-bubble').focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog', { name: 'Message actions', exact: true })).toBeVisible()
  return page.getByRole('dialog', { name: 'Message actions', exact: true })
}
async function action(page, row, name) {
  const menu = await openMenu(page, row)
  await menu.getByRole('button', { name, exact: true }).click()
  if (name !== 'Delete') await expect(menu).toHaveCount(0)
}
async function reply(page, id) { await action(page, rowById(page, id), 'Reply') }

async function edit(page, content, replacement) {
  await action(page, messageRow(page, content), 'Edit')
  await page.getByLabel('Edit message text', { exact: true }).fill(replacement)
  const response = page.waitForResponse(r => r.request().method() === 'PATCH' && r.url().includes('/api/messages/'))
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  assert.equal((await response).status(), 200)
  await once(page, replacement)
}

async function remove(page, content, expected = 204) {
  const response = page.waitForResponse(r => r.request().method() === 'DELETE' && r.url().includes('/api/messages/'))
  await action(page, messageRow(page, content), 'Delete')
  await page.getByRole('dialog', { name: 'Delete this message?' }).getByRole('button', { name: 'Delete message', exact: true }).click()
  assert.equal((await response).status(), expected)
  if (expected !== 204) { await expect(page.getByRole('dialog').getByRole('alert')).toContainText(/try again/i) }
}

function photo(page, id) {
  return page.locator(`img[data-attachment-id="${id}"]`)
}

async function visiblePhoto(page, id) {
  await page.locator(`[data-attachment-placeholder="${id}"]`).scrollIntoViewIfNeeded()
  await expect(photo(page, id)).toHaveCount(1)
  await expect(photo(page, id)).toBeVisible()
  await expect.poll(() => photo(page, id).evaluate(image => image.complete && image.naturalWidth === 640)).toBe(true)
}

async function sendPhoto(page, filename, caption = '') {
  await page.getByLabel('Choose image', { exact: true }).setInputFiles(filename)
  await expect(page.getByAltText('Selected image preview')).toBeVisible()
  await page.locator('#message-content').fill(caption)
  const response = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/messages/image'))
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  const saved = await response
  assert.equal(saved.status(), 201)
  const message = await saved.json()
  assert.equal(message.content, caption)
  assert.equal(message.attachment.kind, 'image')
  assert.equal(message.delivered_at, null)
  await expect(page.getByAltText('Selected image preview')).toHaveCount(0)
  return message
}

function rowById(page, id) {
  return page.locator(`.chat-history li[data-message-id="${id}"]`)
}

async function editById(page, id, content) {
  await action(page, rowById(page, id), 'Edit')
  await page.getByLabel('Edit message text', { exact: true }).fill(content)
  const response = page.waitForResponse(r => r.request().method() === 'PATCH' && r.url().endsWith(`/api/messages/${id}`))
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  assert.equal((await response).status(), 200)
}

async function removeById(page, id) {
  const response = page.waitForResponse(r => r.request().method() === 'DELETE' && r.url().endsWith(`/api/messages/${id}`))
  await action(page, rowById(page, id), 'Delete')
  await page.getByRole('dialog', { name: 'Delete this message?' }).getByRole('button', { name: 'Delete message', exact: true }).click()
  assert.equal((await response).status(), 204)
}

async function chooseReaction(page, id, name) {
  await openMenu(page, rowById(page, id))
  const response = page.waitForResponse(r => r.url().includes(`/api/messages/${id}/reactions`) && ['POST', 'DELETE'].includes(r.request().method()))
  await page.getByRole('dialog').getByRole('group', { name: 'Choose reaction' }).getByRole('button', { name: new RegExp(`^(Add|Remove) ${name} reaction$`) }).click()
  assert.ok([200, 201].includes((await response).status()))
  await expect(page.getByRole('group', { name: 'Choose reaction' })).toHaveCount(0)
}

async function reaction(page, id, name, count, mine = false) {
  const button = rowById(page, id).getByRole('group', { name: 'Message reactions' }).getByRole('button', { name: new RegExp(`^\\d+ ${name} reactions?\\.`) })
  if (!count) await expect(button).toHaveCount(0)
  else {
    await expect(button).toHaveAccessibleName(new RegExp(`^${count} ${name} reactions?\\.`))
    await expect(button).toHaveAttribute('aria-pressed', String(mine))
  }
}

async function main() {
  execFileSync(path.join(backendDirectory, '.venv/bin/python'), ['-c', 'from PIL import Image; import sys,pathlib; root=pathlib.Path(sys.argv[1]); image=Image.new("RGB", (640,360), "coral"); [image.save(root / ("fixture."+ext), format=fmt) for ext,fmt in [("jpg","JPEG"),("png","PNG"),("webp","WEBP")]]', temporary])
  await startBackend()
  browser = await chromium.launch({ headless: true })
  const aliceContext = await browser.newContext(), bobContext = await browser.newContext(), charlieContext = await browser.newContext()
  let alice = await newPage(aliceContext)
  const bob = await newPage(bobContext), charlie = await newPage(charlieContext)
  await registerAndLogin(alice, names.alice)
  await expect(alice.getByText('No conversations yet.')).toBeVisible()
  await registerAndLogin(bob, names.bob)
  await registerAndLogin(charlie, names.charlie)
  await navigate(alice, 'Contacts')
  await alice.locator('#user-search').fill(names.bob.toUpperCase())
  await expect(directoryRow(alice, names.bob)).toBeVisible()
  await alice.locator('#user-search').fill('')
  await select(alice, names.bob)
  await expect(recentRow(alice, names.bob).getByLabel('Last message preview')).toHaveText('No messages yet.')
  await select(bob, names.alice)
  const bobTab = await newPage(bobContext)
  await bobTab.waitForFunction(() => window.realtimeTest.authenticated === 1)
  await select(bobTab, names.alice)
  await directoryPresence(alice, names.bob, 'online')
  await directoryPresence(bob, names.alice, 'online')
  for (const page of [alice, bob]) await expect(page.getByLabel('Contact presence')).toHaveText('online')
  const aliceId = await bob.evaluate(() => window.realtimeTest.received.find(e => e.type === 'presence:snapshot').data.online_user_ids[0])
  assert.ok(aliceId > 0)
  const typing = bob.getByLabel('Typing indicator')
  await alice.locator('#message-content').fill('draft')
  await expect(typing).toHaveText(`${names.alice} is typing...`)
  for (let i = 0; i < 5; i++) await alice.locator('#message-content').fill(`draft ${i}`)
  assert.equal(await alice.evaluate(() => window.realtimeTest.sentTyping.filter(e => e.type === 'typing:start').length), 1)
  await expect(alice.getByLabel('Typing indicator')).toHaveText('')
  await expect(bob.locator('.message-bubble')).toHaveCount(0)
  await expect(typing).toHaveText('', { timeout: 3500 })
  await alice.locator('#message-content').fill('cleared draft')
  await expect(typing).not.toHaveText('')
  await alice.locator('#message-content').fill('')
  await expect(typing).toHaveText('')

  // Continued input renews a start at most every two seconds.
  for (let i = 0; i < 7; i++) {
    await alice.locator('#message-content').fill(`long draft ${i}`)
    await new Promise(resolve => setTimeout(resolve, 750))
  }
  await expect(typing).not.toHaveText('')
  await select(alice, names.charlie)
  await expect(typing).toHaveText('')
  await alice.locator('#message-content').fill('unrelated draft')
  await expect(typing).toHaveText('')
  await select(alice, names.bob)

  // Missed stop events must expire even if the sender remains online.
  await alice.evaluate(() => { window.realtimeTest.dropTypingStop = true })
  await alice.locator('#message-content').fill('missed stop')
  await expect(typing).not.toHaveText('')
  await expect(typing).toHaveText('', { timeout: 5500 })
  await alice.evaluate(() => { window.realtimeTest.dropTypingStop = false })
  await alice.locator('#message-content').fill('closing draft')
  await expect(typing).not.toHaveText('')
  await alice.close()
  await directoryPresence(bob, names.alice, 'offline')
  await expect(typing).toHaveText('', { timeout: 5500 })
  alice = await newPage(aliceContext)
  await alice.waitForFunction(() => window.realtimeTest.authenticated === 1)
  await select(alice, names.bob)
  await directoryPresence(bob, names.alice, 'online')
  await expect(alice.getByLabel('Contact presence')).toHaveText('online')
  console.log('PASS presence snapshot, typing start/stop, throttling, continued typing, clear input, switching, stale expiry, unexpected tab close/reconnect')
  await select(bob, names.charlie)
  await select(bobTab, names.charlie)
  // Force the acknowledgement to arrive before the HTTP response: the status
  // cache must preserve it when that response finally adds the message.
  await alice.route('**/api/conversations/*/messages', async route => {
    if (route.request().method() !== 'POST') return route.continue()
    const response = await route.fetch()
    const saved = await response.json()
    await alice.waitForFunction(id => window.realtimeTest.statuses.some(s => s.message_id === id && s.delivered_at && !s.read_at), saved.id)
    await route.fulfill({ response })
  })
  await alice.evaluate(() => { window.realtimeTest.dropNewMessage = true })
  const firstMessage = await send(alice, 'hello bob')
  await alice.evaluate(() => { window.realtimeTest.dropNewMessage = false })
  await alice.unroute('**/api/conversations/*/messages')
  await once(alice, 'hello bob')
  await status(alice, 'hello bob', 'Delivered')
  await expect(recentRow(alice, names.bob).getByLabel('Last message preview')).toHaveText('You: hello bob')
  await expect(recentRow(alice, names.bob).locator('time')).toHaveText(/\S/)
  await recentPresence(alice, names.bob, true)
  await select(bob, names.alice)
  await status(alice, 'hello bob', 'Read')
  await select(bobTab, names.alice)
  for (const page of [alice, bob, bobTab]) await once(page, 'hello bob')
  await expect(bob.locator('.message-bubble').filter({ hasText: 'hello bob' }).getByLabel('Message status')).toHaveCount(0)
  await expect(typing).toHaveText('')
  await send(bob, 'hello alice')
  for (const page of [alice, bob, bobTab]) await once(page, 'hello alice')
  await status(bob, 'hello alice', 'Read')
  await status(bobTab, 'hello alice', 'Read')
  await expect(recentRow(alice, names.bob).getByLabel('Last message preview')).toHaveText('hello alice')
  // A third authenticated user cannot forge receipts, even with identity claims.
  const originalStatus = await alice.evaluate(id => window.realtimeTest.statuses.filter(s => s.message_id === id).at(-1), firstMessage.id)
  await charlie.evaluate(id => {
    for (const type of ['message:delivered', 'message:read']) window.realtimeTest.socket.send(JSON.stringify({ type, message_id: id, recipient_id: 2 }))
  }, firstMessage.id)
  await bob.reload()
  await bob.waitForFunction(() => window.realtimeTest.authenticated === 1)
  await select(bob, names.alice)
  await once(bob, 'hello bob')
  await once(bob, 'hello alice')
  await status(bob, 'hello alice', 'Read')
  assert.deepEqual(await alice.evaluate(id => window.realtimeTest.statuses.filter(s => s.message_id === id).at(-1), firstMessage.id), originalStatus)
  console.log('PASS registration, login, search, realtime both ways, multiple tabs, deduplication, refresh history')

  await select(alice, names.charlie)
  await send(bob, 'other conversation')
  await alice.waitForFunction(() => window.realtimeTest.events.some(m => m.content === 'other conversation'))
  await expect(alice.locator('.message-bubble')).toHaveCount(0)
  await expect(alice.locator('.recent-row').first()).toContainText(names.bob)
  await expect(recentRow(alice, names.bob).getByLabel('Last message preview')).toHaveText('other conversation')
  await status(bob, 'other conversation', 'Delivered')
  await select(alice, names.bob)
  await once(alice, 'other conversation')
  await status(bob, 'other conversation', 'Read')
  await bobTab.close()
  await expect(alice.getByLabel('Contact presence')).toHaveText('online')
  assert.equal(await alice.evaluate(() => window.realtimeTest.received.filter(e => e.type === 'presence:update' && e.data.status === 'offline').length), 0)
  await logout(bob)
  await bob.waitForFunction(() => window.realtimeTest.closed >= 1)
  await expect(alice.getByLabel('Contact presence')).toHaveText(/last seen just now|last seen \d+ minutes? ago/)
  await recentPresence(alice, names.bob, false)
  const offlinePresence = await alice.evaluate(() => window.realtimeTest.received.findLast(e => e.type === 'presence:update' && e.data.status === 'offline').data)
  assert.ok(Number.isSafeInteger(offlinePresence.revision))
  assert.ok(Number.isFinite(Date.parse(offlinePresence.last_seen_at)))
  assert.ok(Date.parse(offlinePresence.server_time) >= Date.parse(offlinePresence.last_seen_at))
  // Exercise the real WebSocket parser with a delayed event from BEFORE logout.
  await alice.evaluate(async data => {
    window.realtimeTest.socket.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({ type: 'presence:update', data: { ...data, status: 'online', revision: data.revision - 1 } }),
    }))
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  }, offlinePresence)
  await expect(alice.getByLabel('Contact presence')).toHaveText(/last seen just now|last seen \d+ minutes? ago/)
  // Refresh obtains the same persisted timestamp, without an offline WS event.
  await alice.reload()
  await alice.waitForFunction(() => window.realtimeTest.authenticated === 1)
  const persistedPresenceBody = await presenceBody(alice)
  assert.ok(persistedPresenceBody.users.some(peer => peer.user_id === offlinePresence.user_id && peer.last_seen_at === offlinePresence.last_seen_at))
  await select(alice, names.bob)
  await expect(alice.getByLabel('Contact presence')).toHaveText(/last seen just now|last seen \d+ minutes? ago/)
  const beforePresenceReconnect = await alice.evaluate(() => window.realtimeTest.authenticated)
  await alice.evaluate(() => window.realtimeTest.socket.close())
  await alice.waitForFunction(previous => window.realtimeTest.authenticated > previous, beforePresenceReconnect)
  await expect(alice.getByLabel('Contact presence')).toHaveText(/last seen just now|last seen \d+ minutes? ago/)
  // A separate explicit missing-data fixture must render the honest fallback.
  await withMissingLastSeen(offlinePresence.user_id, async () => {
    await alice.reload()
    await alice.waitForFunction(() => window.realtimeTest.authenticated === 1)
    const missingPresenceBody = await presenceBody(alice)
    assert.ok(missingPresenceBody.users.some(peer => peer.user_id === offlinePresence.user_id && peer.last_seen_at === null))
    await select(alice, names.bob)
    await expect(alice.getByLabel('Contact presence')).toHaveText('offline')
  })
  await alice.reload()
  await alice.waitForFunction(() => window.realtimeTest.authenticated === 1)
  const restoredPresenceBody = await presenceBody(alice)
  assert.ok(restoredPresenceBody.users.some(peer => peer.user_id === offlinePresence.user_id && peer.last_seen_at === offlinePresence.last_seen_at))
  await select(alice, names.bob)
  await expect(alice.getByLabel('Contact presence')).toHaveText(/last seen just now|last seen \d+ minutes? ago/)
  console.log('PASS immediate last seen, persisted refresh, observer reconnect, stale online event and missing-timestamp fallback')
  const logoutEvents = await bob.evaluate(() => window.realtimeTest.events.length)
  const offlineMessage = await send(alice, 'offline recipient')
  await status(alice, 'offline recipient', 'Sent')
  await charlie.evaluate(id => {
    for (const type of ['message:delivered', 'message:read']) window.realtimeTest.socket.send(JSON.stringify({ type, message_id: id, recipient_id: 2 }))
  }, offlineMessage.id)
  await new Promise(resolve => setTimeout(resolve, 2300))
  await status(alice, 'offline recipient', 'Sent')
  assert.equal(await bob.evaluate(() => window.realtimeTest.events.length), logoutEvents)
  await bob.locator('#login-username').fill(names.bob)
  await bob.locator('#login-password').fill('password123')
  await require('./captcha.cjs').ready(bob)
  await bob.getByRole('button', { name: 'Log in', exact: true }).click()
  await select(bob, names.alice)
  await expect(alice.getByLabel('Contact presence')).toHaveText('online')
  await alice.evaluate(async data => {
    window.realtimeTest.socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'presence:update', data }) }))
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  }, offlinePresence)
  await expect(alice.getByLabel('Contact presence')).toHaveText('online')
  await once(bob, 'offline recipient')
  await status(alice, 'offline recipient', 'Read')
  await alice.reload()
  await alice.waitForFunction(() => window.realtimeTest.authenticated === 1)
  await select(alice, names.bob)
  await status(alice, 'offline recipient', 'Read')
  await status(alice, 'hello bob', 'Read')
  await expect(alice.getByLabel('Contact presence')).toHaveText('online')
  console.log('PASS conversation isolation, logout socket cleanup, offline recipient history')

  const beforeRestart = await Promise.all([alice, bob].map(page => page.evaluate(() => window.realtimeTest.authenticated)))
  await stopBackend()
  await alice.waitForFunction(() => window.realtimeTest.closed >= 1)
  await new Promise(resolve => setTimeout(resolve, 2500))
  await expect(alice.locator('#message-content')).toBeEnabled()
  await startBackend()
  for (const [index, page] of [alice, bob].entries()) {
    await page.waitForFunction(previous => window.realtimeTest.authenticated > previous, beforeRestart[index])
  }
  for (const page of [alice, bob]) await expect(page.getByLabel('Contact presence')).toHaveText('online')
  await recentPresence(alice, names.bob, true)
  await send(bob, 'after restart')
  await once(alice, 'after restart')
  await once(bob, 'after restart')
  await status(bob, 'after restart', 'Read')
  await expect(recentRow(alice, names.bob).getByLabel('Last message preview')).toHaveText('after restart')
  await expect(recentRow(alice, names.charlie).getByLabel('Last message preview')).toHaveText('No messages yet.')
  await openRecent(alice, names.bob)
  await once(alice, 'hello bob')
  await expect(recentRow(alice, names.bob)).toHaveAttribute('aria-pressed', 'true')

  await select(charlie, names.alice)
  await openRecent(alice, names.charlie)
  const longPreview = `A long preview ${'detail '.repeat(80)}\nsecond line`
  await send(alice, longPreview)
  await expect(alice.locator('.recent-row').first()).toContainText(names.charlie)
  const preview = recentRow(alice, names.charlie).getByLabel('Last message preview')
  await expect(preview).toHaveText(`You: ${longPreview.replace(/\s+/g, ' ')}`)
  assert.equal(await preview.evaluate(element => getComputedStyle(element).textOverflow), 'ellipsis')
  await send(bob, 'Bob becomes most recent')
  await expect(alice.locator('.recent-row').first()).toContainText(names.bob)
  await expect(recentRow(alice, names.bob).getByLabel('Last message preview')).toHaveText('Bob becomes most recent')
  await status(bob, 'Bob becomes most recent', 'Delivered')
  await openRecent(alice, names.bob)
  await once(alice, 'Bob becomes most recent')
  await status(bob, 'Bob becomes most recent', 'Read')
  await alice.reload()
  await expect(alice.locator('.recent-row').first()).toContainText(names.bob)
  await expect(recentRow(alice, names.charlie)).toContainText('A long preview')
  await openRecent(alice, names.bob)
  await status(alice, 'offline recipient', 'Read')

  // Mobile switches between full-width list and chat; rows remain keyboard buttons.
  await alice.setViewportSize({ width: 375, height: 812 })
  await expect(alice.getByLabel('Recent conversations')).toBeHidden()
  await expect(alice.getByRole('button', { name: 'Back' })).toBeVisible()
  await alice.getByRole('button', { name: 'Back' }).click()
  await expect(alice.getByLabel('Recent conversations')).toBeVisible()
  await expect(alice.locator('#message-content')).toBeHidden()
  await recentRow(alice, names.bob).focus()
  await alice.keyboard.press('Enter')
  await expect(alice.locator('#chat-title')).toHaveText(`@${names.bob}`)
  assert.equal(await alice.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
  await alice.getByRole('button', { name: 'Back' }).click()
  await alice.setViewportSize({ width: 1280, height: 800 })

  // Unread counts while on the list, with replay protection and a second tab.
  await unread(alice, names.bob, 0)
  let third
  for (let index = 1; index <= 3; index++) {
    third = await send(bob, `unread batch ${index}`)
    await unread(alice, names.bob, index)
    await unread(bob, names.alice, 0)
  }
  await expect(alice.locator('.recent-row').first()).toContainText(names.bob)
  await alice.evaluate(message => window.realtimeTest.socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'message:new', data: message }) })), third)
  await unread(alice, names.bob, 3)
  const aliceTab = await newPage(aliceContext)
  await unread(aliceTab, names.bob, 3)
  await openRecent(alice, names.bob)
  await status(bob, 'unread batch 3', 'Read')
  await unread(alice, names.bob, 0)
  await unread(aliceTab, names.bob, 0)
  await send(bob, 'active unread regression')
  await once(alice, 'active unread regression')
  await status(bob, 'active unread regression', 'Read')
  await unread(alice, names.bob, 0)
  await unread(aliceTab, names.bob, 0)

  // An open but hidden conversation is delivered, not read, until visible.
  await alice.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await send(bob, 'hidden conversation unread')
  await status(bob, 'hidden conversation unread', 'Delivered')
  await unread(alice, names.bob, 1)
  await alice.evaluate(() => {
    delete document.visibilityState
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await status(bob, 'hidden conversation unread', 'Read')
  await unread(aliceTab, names.bob, 0)

  await openRecent(alice, names.charlie)
  await send(bob, 'switched conversation unread')
  await unread(alice, names.bob, 1)
  await alice.reload()
  await unread(alice, names.bob, 1)
  const priorAuth = await alice.evaluate(() => window.realtimeTest.authenticated)
  await stopBackend()
  await startBackend()
  await alice.waitForFunction(previous => window.realtimeTest.authenticated > previous, priorAuth)
  await unread(alice, names.bob, 1)
  await openRecent(alice, names.bob)
  await status(bob, 'switched conversation unread', 'Read')
  await unread(aliceTab, names.bob, 0)
  await aliceTab.close()
  await logout(alice)
  await directoryPresence(bob, names.alice, 'offline')
  for (let index = 1; index <= 4; index++) await send(bob, `offline unread ${index}`)
  await alice.locator('#login-username').fill(names.alice)
  await alice.locator('#login-password').fill('password123')
  await require('./captcha.cjs').ready(alice)
  await alice.getByRole('button', { name: 'Log in', exact: true }).click()
  await unread(alice, names.bob, 4)
  await alice.setViewportSize({ width: 375, height: 812 })
  await unread(alice, names.bob, 4)
  assert.equal(await alice.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
  await openRecent(alice, names.bob)
  await status(bob, 'offline unread 4', 'Read')
  await alice.getByRole('button', { name: 'Back' }).click()
  await unread(alice, names.bob, 0)
  await alice.setViewportSize({ width: 1280, height: 800 })
  console.log('PASS unread 1/3, duplicate delivery, read clear across tabs, active/hidden chats, switching, refresh/restart, offline four-message recovery, mobile badges')

  await openRecent(alice, names.bob)
  const mutationTab = await newPage(aliceContext)
  await openRecent(mutationTab, names.bob)
  await send(alice, 'Hello Bbo mutation')
  await status(alice, 'Hello Bbo mutation', 'Read')
  await action(alice, messageRow(alice, 'Hello Bbo mutation'), 'Edit')
  await alice.getByLabel('Edit message text', { exact: true }).fill('Cancelled draft')
  await alice.getByRole('button', { name: 'Cancel edit', exact: true }).click()
  await once(alice, 'Hello Bbo mutation')
  await alice.route('**/api/messages/*', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"detail":"test unavailable"}' }))
  await action(alice, messageRow(alice, 'Hello Bbo mutation'), 'Edit')
  await alice.getByLabel('Edit message text', { exact: true }).fill('Hello Bob mutation')
  await alice.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(alice.getByRole('alert')).toContainText(/try again/i)
  await once(alice, 'Hello Bbo mutation')
  await alice.unroute('**/api/messages/*')
  await alice.getByRole('button', { name: 'Save', exact: true }).click()
  for (const page of [alice, bob, mutationTab]) {
    await once(page, 'Hello Bob mutation')
    await expect(messageRow(page, 'Hello Bob mutation').getByLabel('Edited message')).toHaveText('Edited')
  }
  await status(alice, 'Hello Bob mutation', 'Read')
  await openMenu(bob, messageRow(bob, 'Hello Bob mutation'))
  await expect(bob.getByRole('dialog').getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0)
  await expect(bob.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0)
  await bob.keyboard.press('Escape')
  await expect(recentRow(alice, names.bob).getByLabel('Last message preview')).toHaveText('You: Hello Bob mutation')
  await edit(alice, 'Hello Bob mutation', 'Repeated edit mutation')
  await once(bob, 'Repeated edit mutation')
  await alice.reload()
  await openRecent(alice, names.bob)
  await once(alice, 'Repeated edit mutation')
  await action(alice, messageRow(alice, 'Repeated edit mutation'), 'Delete')
  await alice.getByRole('dialog', { name: 'Delete this message?' }).getByRole('button', { name: 'Cancel', exact: true }).click()
  await alice.keyboard.press('Escape')
  await expect(alice.getByRole('dialog')).toHaveCount(0)
  await once(alice, 'Repeated edit mutation')
  await alice.route('**/api/messages/*', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"detail":"test unavailable"}' }))
  await remove(alice, 'Repeated edit mutation', 503)
  await expect(alice.getByRole('alert')).toContainText(/try again/i)
  await once(alice, 'Repeated edit mutation')
  await alice.unroute('**/api/messages/*')
  await remove(alice, 'Repeated edit mutation')
  for (const page of [alice, bob, mutationTab]) await expect(page.locator('.message-bubble').filter({ hasText: 'Repeated edit mutation' })).toHaveCount(0)
  await expect(recentRow(alice, names.bob).getByLabel('Last message preview')).toHaveText('offline unread 4')
  await bob.reload()
  await select(bob, names.alice)
  await expect(bob.locator('.message-bubble').filter({ hasText: 'Repeated edit mutation' })).toHaveCount(0)

  await logout(bob)
  await edit(alice, 'offline recipient', 'Offline edit persists')
  await send(alice, 'Removed while offline')
  await remove(alice, 'Removed while offline')
  await bob.locator('#login-username').fill(names.bob)
  await bob.locator('#login-password').fill('password123')
  await require('./captcha.cjs').ready(bob)
  await bob.getByRole('button', { name: 'Log in', exact: true }).click()
  await select(bob, names.alice)
  await once(bob, 'Offline edit persists')
  await expect(bob.locator('.message-bubble').filter({ hasText: 'Removed while offline' })).toHaveCount(0)
  await openRecent(alice, names.charlie)
  await openRecent(mutationTab, names.charlie)
  for (let index = 1; index <= 3; index++) await send(bob, `Delete unread ${index}`)
  await unread(alice, names.bob, 3)
  await remove(bob, 'Delete unread 3')
  await unread(alice, names.bob, 2)
  await unread(mutationTab, names.bob, 2)
  await expect(recentRow(alice, names.bob).getByLabel('Last message preview')).toHaveText('Delete unread 2')
  await remove(bob, 'Delete unread 2')
  await remove(bob, 'Delete unread 1')
  await unread(alice, names.bob, 0)
  await edit(alice, 'A long preview', 'Edited Charlie preview')
  await expect(alice.locator('.recent-row').first()).toContainText(names.bob)
  await expect(recentRow(alice, names.charlie).getByLabel('Last message preview')).toHaveText('You: Edited Charlie preview')
  await remove(alice, 'Edited Charlie preview')
  await expect(recentRow(alice, names.charlie).getByLabel('Last message preview')).toHaveText('No messages yet.')
  await openRecent(alice, names.bob)
  await openRecent(mutationTab, names.bob)
  await send(bob, 'After mutations')
  await status(bob, 'After mutations', 'Read')
  await once(alice, 'After mutations')
  await mutationTab.close()
  console.log('PASS own edits/repeated edits, labels, preserved receipts, real-time edit/delete across tabs, confirmation/cancel, failure retry, offline history, unread deletion, latest/empty previews, original activity ordering')

  const imageTab = await newPage(aliceContext)
  await openRecent(imageTab, names.bob)
  const jpeg = path.join(temporary, 'fixture.jpg'), png = path.join(temporary, 'fixture.png'), webp = path.join(temporary, 'fixture.webp')
  const contentRequests = []
  for (const page of [alice, bob, imageTab]) page.on('request', request => {
    if (request.url().includes('/api/attachments/')) contentRequests.push({ authorized: Boolean(request.headers().authorization), url: request.url() })
  })
  let uploads = 0
  const countUpload = request => { if (request.url().endsWith('/messages/image') && request.method() === 'POST') uploads++ }
  alice.on('request', countUpload)
  const chooser = alice.waitForEvent('filechooser')
  await alice.getByRole('button', { name: 'Image', exact: true }).click()
  await (await chooser).setFiles(jpeg)
  await expect(alice.getByAltText('Selected image preview')).toBeVisible()
  const cancelledUrl = await alice.getByAltText('Selected image preview').getAttribute('src')
  assert.equal(uploads, 0)
  await alice.getByRole('button', { name: 'Remove image' }).click()
  await expect(alice.getByAltText('Selected image preview')).toHaveCount(0)
  assert.ok(await alice.evaluate(url => window.imageUrls.revoked.includes(url), cancelledUrl))
  alice.off('request', countUpload)

  // Failed upload retains the selection and shows a retryable error.
  await alice.getByLabel('Choose image', { exact: true }).setInputFiles({ name: 'fake.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('not an image') })
  await alice.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(alice.getByRole('alert')).toContainText('valid JPEG')
  await expect(alice.getByAltText('Selected image preview')).toBeVisible()
  await alice.getByRole('button', { name: 'Remove image' }).click()
  const firstPhoto = await sendPhoto(alice, jpeg, 'Vacation photo')
  for (const page of [alice, bob, imageTab]) await visiblePhoto(page, firstPhoto.attachment.id)
  await status(alice, 'Vacation photo', 'Read')
  await openMenu(alice, messageRow(alice, 'Vacation photo'))
  await expect(alice.getByRole('dialog').getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0)
  await alice.keyboard.press('Escape')
  await expect(recentRow(alice, names.bob).getByLabel('Last message preview')).toHaveText('You: Photo · Vacation photo')
  const secondPhoto = await sendPhoto(alice, png)
  for (const page of [alice, bob, imageTab]) await visiblePhoto(page, secondPhoto.attachment.id)
  await expect(recentRow(alice, names.bob).getByLabel('Last message preview')).toHaveText('You: Photo')
  await expect(alice.locator('body')).not.toContainText('[image]')
  await expect(bob.locator('body')).not.toContainText('[image]')
  const thirdPhoto = await sendPhoto(alice, webp, 'WEBP photo')
  for (const page of [alice, bob, imageTab]) await visiblePhoto(page, thirdPhoto.attachment.id)
  await expect(alice.locator('.recent-row').first()).toContainText(names.bob)
  await alice.reload()
  await openRecent(alice, names.bob)
  await bob.reload()
  await openRecent(bob, names.alice)
  for (const page of [alice, bob]) for (const message of [firstPhoto, secondPhoto, thirdPhoto]) await visiblePhoto(page, message.attachment.id)
  await openRecent(bob, names.charlie)
  const unreadPhoto = await sendPhoto(alice, png, 'Unread photo')
  await unread(bob, names.alice, 1)
  await status(alice, 'Unread photo', 'Delivered')
  await expect(recentRow(bob, names.alice).getByLabel('Last message preview')).toHaveText('Photo · Unread photo')
  await openRecent(bob, names.alice)
  await visiblePhoto(bob, unreadPhoto.attachment.id)
  await status(alice, 'Unread photo', 'Read')
  await unread(bob, names.alice, 0)
  const removedUrls = await Promise.all([alice, bob, imageTab].map(async page => { await visiblePhoto(page, firstPhoto.attachment.id); return photo(page, firstPhoto.attachment.id).getAttribute('src') }))
  await remove(alice, 'Vacation photo')
  for (const [index, page] of [alice, bob, imageTab].entries()) {
    await expect(photo(page, firstPhoto.attachment.id)).toHaveCount(0)
    assert.ok(await page.evaluate(url => window.imageUrls.revoked.includes(url), removedUrls[index]))
  }
  assert.equal(fs.readdirSync(path.join(temporary, 'uploads/images')).length, 3)
  await remove(alice, 'Unread photo')
  await expect(recentRow(alice, names.bob).getByLabel('Last message preview')).toHaveText('You: Photo · WEBP photo')
  assert.equal(fs.readdirSync(path.join(temporary, 'uploads/images')).length, 2)
  await logout(bob)
  const offlinePhoto = await sendPhoto(alice, jpeg, 'Offline photo')
  await status(alice, 'Offline photo', 'Sent')
  await bob.locator('#login-username').fill(names.bob)
  await bob.locator('#login-password').fill('password123')
  await require('./captcha.cjs').ready(bob)
  await bob.getByRole('button', { name: 'Log in', exact: true }).click()
  await unread(bob, names.alice, 1)
  await openRecent(bob, names.alice)
  await visiblePhoto(bob, offlinePhoto.attachment.id)
  await status(alice, 'Offline photo', 'Read')
  const beforeImageRestart = await alice.evaluate(() => window.realtimeTest.authenticated)
  await stopBackend()
  await startBackend()
  await alice.waitForFunction(previous => window.realtimeTest.authenticated > previous, beforeImageRestart)
  await alice.reload()
  await openRecent(alice, names.bob)
  await bob.reload()
  await openRecent(bob, names.alice)
  for (const page of [alice, bob]) {
    for (const message of [secondPhoto, thirdPhoto, offlinePhoto]) await visiblePhoto(page, message.attachment.id)
    await expect(photo(page, firstPhoto.attachment.id)).toHaveCount(0)
    await expect(photo(page, unreadPhoto.attachment.id)).toHaveCount(0)
  }
  await alice.setViewportSize({ width: 375, height: 812 })
  assert.equal(await alice.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
  await alice.setViewportSize({ width: 1280, height: 800 })
  assert.ok(contentRequests.length >= 10 && contentRequests.every(request => request.authorized))
  await imageTab.close()
  console.log('PASS image picker/cancel, failed upload retry, JPEG/PNG/WEBP, empty/captioned images, authenticated blob rendering/revocation, receipts/unread/previews, multiple tabs, deletion/files, offline history, refresh/restart, mobile')

  const question = await send(bob, 'Are you coming tonight?')
  await action(alice, rowById(alice, question.id), 'Reply')
  await expect(alice.getByLabel('Reply composer')).toContainText(names.bob)
  await expect(alice.getByLabel('Reply composer')).toContainText('Are you coming tonight?')
  await alice.getByRole('button', { name: 'Cancel reply' }).click()
  await expect(alice.getByLabel('Reply composer')).toHaveCount(0)
  await action(alice, rowById(alice, question.id), 'Reply')
  // A failed send retains the selected reply for retry.
  await alice.route('**/api/conversations/*/messages', route => route.request().method() === 'POST'
    ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"detail":"test unavailable"}' }) : route.continue())
  await alice.locator('#message-content').fill('Yes, at 8.')
  await alice.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(alice.getByRole('alert')).toContainText(/try again/i)
  await expect(alice.getByLabel('Reply composer')).toContainText('Are you coming tonight?')
  await alice.unroute('**/api/conversations/*/messages')
  const answer = await send(alice, 'Yes, at 8.')
  assert.equal(answer.reply_to.id, question.id)
  await expect(alice.getByLabel('Reply composer')).toHaveCount(0)
  for (const page of [alice, bob]) {
    await expect(rowById(page, answer.id).getByLabel('Reply preview')).toContainText('Are you coming tonight?')
  }
  await status(alice, 'Yes, at 8.', 'Read')
  await expect(recentRow(alice, names.bob).getByLabel('Last message preview')).toHaveText('You: Yes, at 8.')
  await rowById(alice, answer.id).getByLabel('Reply preview').click()
  await expect(rowById(alice, question.id)).toBeInViewport()
  await alice.reload()
  await openRecent(alice, names.bob)
  await bob.reload()
  await openRecent(bob, names.alice)
  for (const page of [alice, bob]) await expect(rowById(page, answer.id).getByLabel('Reply preview')).toContainText('Are you coming tonight?')
  await editById(alice, answer.id, 'Yes, at 9.')
  await expect(rowById(bob, answer.id)).toContainText('Yes, at 9.')
  await expect(rowById(alice, answer.id).getByLabel('Reply preview')).toContainText('Are you coming tonight?')
  await editById(bob, question.id, 'Updated question tonight?')
  for (const page of [alice, bob]) await expect(rowById(page, answer.id).getByLabel('Reply preview')).toContainText('Updated question tonight?')
  await action(alice, rowById(alice, question.id), 'Reply')
  await openRecent(alice, names.charlie)
  await expect(alice.getByLabel('Reply composer')).toHaveCount(0)
  await openRecent(alice, names.bob)

  await action(alice, rowById(alice, offlinePhoto.id), 'Reply')
  await expect(alice.getByLabel('Reply composer')).toContainText('Photo · Offline photo')
  const photoAnswer = await send(alice, 'Reply to photo')
  await expect(rowById(bob, photoAnswer.id).getByLabel('Reply preview')).toContainText('Photo · Offline photo')
  await action(alice, rowById(alice, question.id), 'Reply')
  const photoToText = await sendPhoto(alice, png, 'Photo reply to text')
  assert.equal(photoToText.reply_to.id, question.id)
  await expect(rowById(bob, photoToText.id).getByLabel('Reply preview')).toContainText('Updated question tonight?')
  await visiblePhoto(bob, photoToText.attachment.id)
  await action(alice, rowById(alice, secondPhoto.id), 'Reply')
  await expect(alice.getByLabel('Reply composer')).toContainText('Photo')
  const photoToPhoto = await sendPhoto(alice, webp, 'Photo reply to photo')
  await expect(rowById(bob, photoToPhoto.id).getByLabel('Reply preview')).toContainText('Photo')
  await action(alice, rowById(alice, photoToPhoto.id), 'Reply')
  const ownAnswer = await send(alice, 'Own message reply')
  assert.equal(ownAnswer.reply_to.id, photoToPhoto.id)
  assert.equal(ownAnswer.reply_to.reply_to, undefined)
  await expect(rowById(alice, ownAnswer.id).getByLabel('Reply preview')).toContainText('You')
  await status(alice, 'Own message reply', 'Read')
  await removeById(bob, question.id)
  for (const page of [alice, bob]) {
    await expect(rowById(page, question.id)).toHaveCount(0)
    await expect(rowById(page, answer.id)).toBeVisible()
    await expect(rowById(page, answer.id).getByLabel('Reply preview')).toHaveCount(0)
    await expect(rowById(page, photoToText.id).getByLabel('Reply preview')).toHaveCount(0)
  }
  await removeById(alice, photoToPhoto.id)
  for (const page of [alice, bob]) await expect(rowById(page, ownAnswer.id).getByLabel('Reply preview')).toHaveCount(0)
  await bob.reload()
  await openRecent(bob, names.alice)
  await expect(rowById(bob, answer.id).getByLabel('Reply preview')).toHaveCount(0)
  await expect(rowById(bob, photoAnswer.id).getByLabel('Reply preview')).toContainText('Photo · Offline photo')
  await expect(rowById(bob, ownAnswer.id).getByLabel('Reply preview')).toHaveCount(0)
  const beforeReplyRestart = await alice.evaluate(() => window.realtimeTest.authenticated)
  await stopBackend()
  await startBackend()
  await alice.waitForFunction(previous => window.realtimeTest.authenticated > previous, beforeReplyRestart)
  await alice.reload()
  await openRecent(alice, names.bob)
  await expect(rowById(alice, photoAnswer.id).getByLabel('Reply preview')).toContainText('Photo · Offline photo')
  await expect(rowById(alice, answer.id).getByLabel('Reply preview')).toHaveCount(0)
  console.log('PASS reply action/cancel/retry, same conversation, live quotes, scroll-to-target, own replies, edited reply/target, deleted target/reply cleanup, text/image combinations, refresh/restart persistence')

  await openRecent(bob, names.alice)
  const reactionTarget = await send(bob, 'Reaction Hello')
  await status(bob, 'Reaction Hello', 'Read')
  await send(charlie, 'New Charlie activity')
  await expect(alice.locator('.recent-row').first()).toContainText(names.charlie)
  await unread(alice, names.charlie, 1)
  const typingBeforeReactions = await alice.evaluate(() => window.realtimeTest.sentTyping.length)
  await chooseReaction(alice, reactionTarget.id, 'thumbs up')
  await reaction(alice, reactionTarget.id, 'thumbs up', 1, true)
  await reaction(bob, reactionTarget.id, 'thumbs up', 1, false)
  const reactionTab = await newPage(aliceContext)
  await openRecent(reactionTab, names.bob)
  await reaction(reactionTab, reactionTarget.id, 'thumbs up', 1, true)
  await chooseReaction(bob, reactionTarget.id, 'thumbs up')
  for (const page of [alice, bob, reactionTab]) await reaction(page, reactionTarget.id, 'thumbs up', 2, true)
  await chooseReaction(alice, reactionTarget.id, 'heart')
  await reaction(alice, reactionTarget.id, 'heart', 1, true)
  await reaction(bob, reactionTarget.id, 'heart', 1, false)
  await rowById(alice, reactionTarget.id).getByRole('group', { name: 'Message reactions' }).getByRole('button', { name: /^2 thumbs up reactions/ }).click()
  await reaction(alice, reactionTarget.id, 'thumbs up', 1, false)
  await reaction(reactionTab, reactionTarget.id, 'thumbs up', 1, false)
  await reaction(bob, reactionTarget.id, 'thumbs up', 1, true)
  await alice.route(`**/api/messages/${reactionTarget.id}/reactions`, route => route.request().method() === 'POST'
    ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"detail":"test unavailable"}' }) : route.continue())
  await openMenu(alice, rowById(alice, reactionTarget.id))
  await expect(alice.getByRole('dialog').getByRole('group', { name: 'Choose reaction' }).getByRole('button')).toHaveCount(6)
  await alice.getByRole('dialog').getByRole('button', { name: 'Add sad reaction', exact: true }).click()
  await expect(alice.getByRole('dialog').getByRole('alert')).toContainText('Unable to change reaction')
  await reaction(alice, reactionTarget.id, 'thumbs up', 1, false)
  await alice.unroute(`**/api/messages/${reactionTarget.id}/reactions`)
  await alice.getByRole('dialog').getByRole('button', { name: 'Add sad reaction', exact: true }).click()
  await reaction(alice, reactionTarget.id, 'sad', 1, true)

  // Capture an old response and release it after a newer socket-driven fetch.
  let releaseOld, capturedOld
  const holdOld = new Promise(resolve => { releaseOld = resolve })
  const oldCaptured = new Promise(resolve => { capturedOld = resolve })
  let delayNextGet = true
  await alice.route('**/api/conversations/*/sync?*', async route => {
    if (route.request().method() !== 'POST' || !delayNextGet) return route.continue()
    delayNextGet = false
    const response = await route.fetch()
    capturedOld()
    await holdOld
    try { await route.fulfill({ response }) } catch {}
  })
  await alice.evaluate(message => window.realtimeTest.socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'message:reactions', data: { message_id: message.id, conversation_id: message.conversation_id } }) })), reactionTarget)
  await oldCaptured
  await rowById(bob, reactionTarget.id).getByRole('group', { name: 'Message reactions' }).getByRole('button', { name: /^1 thumbs up reaction/ }).click()
  releaseOld()
  await alice.unroute('**/api/conversations/*/sync?*')
  await reaction(alice, reactionTarget.id, 'thumbs up', 0)
  await reaction(reactionTab, reactionTarget.id, 'thumbs up', 0)
  await expect(alice.locator('.recent-row').first()).toContainText(names.charlie)
  await unread(alice, names.charlie, 1)
  await unread(alice, names.bob, 0)
  await expect(recentRow(alice, names.bob).getByLabel('Last message preview')).toHaveText('Reaction Hello')
  assert.equal(await alice.evaluate(() => window.realtimeTest.sentTyping.length), typingBeforeReactions)
  await alice.reload()
  await openRecent(alice, names.bob)
  await bob.reload()
  await openRecent(bob, names.alice)
  await reaction(alice, reactionTarget.id, 'heart', 1, true)
  await reaction(bob, reactionTarget.id, 'heart', 1, false)
  // A shared edit arriving before history must preserve its personalized summary.
  const historyTab = await newPage(aliceContext)
  await historyTab.waitForFunction(() => window.realtimeTest.authenticated === 1)
  let releaseHistory, capturedHistory
  const holdHistory = new Promise(resolve => { releaseHistory = resolve })
  const historyCaptured = new Promise(resolve => { capturedHistory = resolve })
  await historyTab.route('**/api/conversations/*/messages/page?*', async route => {
    const response = await route.fetch()
    capturedHistory()
    await holdHistory
    await route.fulfill({ response })
  })
  const openingHistory = openRecent(historyTab, names.bob)
  await historyCaptured
  await editById(bob, reactionTarget.id, 'Reaction Hello edited while loading')
  await historyTab.waitForFunction(id => window.realtimeTest.mutations.some(message => message.id === id), reactionTarget.id)
  releaseHistory()
  await openingHistory
  await expect(rowById(historyTab, reactionTarget.id)).toContainText('Reaction Hello edited while loading')
  await reaction(historyTab, reactionTarget.id, 'heart', 1, true)
  await historyTab.close()
  await logout(bob)
  await chooseReaction(alice, offlinePhoto.id, 'heart')
  await reaction(alice, offlinePhoto.id, 'heart', 1, true)
  await chooseReaction(alice, photoAnswer.id, 'laughing')
  await reaction(alice, photoAnswer.id, 'laughing', 1, true)
  await bob.locator('#login-username').fill(names.bob)
  await bob.locator('#login-password').fill('password123')
  await require('./captcha.cjs').ready(bob)
  await bob.getByRole('button', { name: 'Log in', exact: true }).click()
  await openRecent(bob, names.alice)
  await reaction(bob, offlinePhoto.id, 'heart', 1, false)
  await reaction(bob, photoAnswer.id, 'laughing', 1, false)
  await editById(alice, photoAnswer.id, 'Reply to photo with reactions')
  await expect(rowById(bob, photoAnswer.id)).toContainText('Reply to photo with reactions')
  await reaction(alice, photoAnswer.id, 'laughing', 1, true)
  await reaction(bob, photoAnswer.id, 'laughing', 1, false)
  await expect(rowById(bob, photoAnswer.id).getByLabel('Reply preview')).toContainText('Photo · Offline photo')
  await removeById(alice, photoAnswer.id)
  await expect(rowById(bob, photoAnswer.id)).toHaveCount(0)
  await removeById(bob, reactionTarget.id)
  await expect(rowById(alice, reactionTarget.id)).toHaveCount(0)
  await expect(rowById(reactionTab, reactionTarget.id)).toHaveCount(0)
  const beforeReactionRestart = await alice.evaluate(() => window.realtimeTest.authenticated)
  await stopBackend()
  await startBackend()
  await alice.waitForFunction(previous => window.realtimeTest.authenticated > previous, beforeReactionRestart)
  await reaction(alice, offlinePhoto.id, 'heart', 1, true)
  await alice.setViewportSize({ width: 375, height: 812 })
  await openMenu(alice, rowById(alice, offlinePhoto.id))
  await expect(alice.getByRole('dialog').getByRole('group', { name: 'Choose reaction' }).getByRole('button')).toHaveCount(6)
  assert.equal(await alice.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
  await alice.keyboard.press('Escape')
  await expect(alice.getByRole('dialog')).toHaveCount(0)
  await alice.setViewportSize({ width: 1280, height: 800 })
  await reactionTab.close()
  console.log('PASS reaction picker/toggle, per-user flags, multiple emoji/users/tabs, failure retry, duplicate/out-of-order refresh, offline persistence, image/reply reactions, edit preservation, delete cleanup, no activity/unread/typing effects, mobile/restart')

  // Explicit failure and retry; no timer-based polling is used by the app.
  await alice.route('**/api/conversations', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"detail":"test unavailable"}' }))
  await alice.reload()
  await expect(alice.getByText('Unable to load conversations.')).toBeVisible()
  await alice.unroute('**/api/conversations')
  await alice.getByRole('button', { name: 'Retry conversations' }).click()
  await expect(recentRow(alice, names.bob)).toBeVisible()
  await alice.route('**/api/conversations', route => route.fulfill({ status: 401, contentType: 'application/json', body: '{"detail":"test expired"}' }))
  await alice.reload()
  await expect(alice.locator('#login-username')).toBeVisible()
  assert.equal(await alice.evaluate(() => localStorage.getItem('smooth_access_token')), null)
  console.log('PASS recent empty state, creation, previews/time/presence, Alice/Bob/Charlie ordering, existing-row history, refresh, mobile/keyboard, retry and 401 cleanup')
  // Confirm persisted count directly, including across server restart.
  const count = execFileSync(path.join(backendDirectory, '.venv/bin/python'), ['-c', 'import sqlite3,sys; print(sqlite3.connect(sys.argv[1]).execute("SELECT count(*) FROM messages").fetchone()[0])', `${temporary}/test.db`], { encoding: 'utf8' })
  assert.equal(Number(count.trim()), 24)
  const receipts = execFileSync(path.join(backendDirectory, '.venv/bin/python'), ['-c', 'import sqlite3,sys; print(sqlite3.connect(sys.argv[1]).execute("SELECT count(*), count(DISTINCT message_id), count(delivered_at), count(read_at) FROM message_receipts").fetchone())', `${temporary}/test.db`], { encoding: 'utf8' })
  assert.equal(receipts.trim(), '(24, 24, 24, 23)')
  const edits = execFileSync(path.join(backendDirectory, '.venv/bin/python'), ['-c', 'import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); print(db.execute("SELECT count(*), min(content) FROM message_edits").fetchone()); print(db.execute("PRAGMA foreign_key_check").fetchall())', `${temporary}/test.db`], { encoding: 'utf8' })
  assert.equal(edits.trim(), "(2, 'Offline edit persists')\n[]")
  const attachments = execFileSync(path.join(backendDirectory, '.venv/bin/python'), ['-c', 'import sqlite3,sys,pathlib; root=pathlib.Path(sys.argv[1]); db=sqlite3.connect(root / "test.db"); names=[r[0] for r in db.execute("SELECT storage_name FROM message_attachments")]; print(len(names), len(list((root / "uploads/images").iterdir())), all((root / "uploads/images" / name).is_file() for name in names))', temporary], { encoding: 'utf8' })
  assert.equal(attachments.trim(), '4 4 True')
  const replies = execFileSync(path.join(backendDirectory, '.venv/bin/python'), ['-c', 'import sqlite3,sys; print(sqlite3.connect(sys.argv[1]).execute("SELECT count(*) FROM message_replies").fetchone()[0])', `${temporary}/test.db`], { encoding: 'utf8' })
  assert.equal(Number(replies.trim()), 0)
  const reactions = execFileSync(path.join(backendDirectory, '.venv/bin/python'), ['-c', 'import sqlite3,sys; print(sqlite3.connect(sys.argv[1]).execute("SELECT count(*), min(emoji) FROM message_reactions").fetchone())', `${temporary}/test.db`], { encoding: 'utf8' })
  assert.equal(reactions.trim(), "(1, '❤️')")
  assert.deepEqual(errors, [])
  console.log('PASS backend restart/reconnect, exactly 24 persisted messages, zero uncaught browser errors')
  console.log('PASS inactive Delivered, active Read, receipt-before-HTTP race, multiple-tab receipts, offline Sent/history Read, refresh persistence, forged acknowledgements, 24 persisted receipts')
}

if (require.main === module) main().catch(async error => { console.error(error); process.exitCode = 1; await captureFailure(browser, error) }).finally(async () => {
  if (browser) await browser.close()
  await stopBackend()
  fs.rmSync(temporary, { recursive: true, force: true })
})

module.exports = { startBackend, stopBackend, newPage, registerAndLogin, select, openRecent,
  send, status, rowById, openMenu, action, reply, chooseReaction, reaction, visiblePhoto, navigate, logout, names, temporary, backendDirectory, errors, captureFailure, recentPresence }
