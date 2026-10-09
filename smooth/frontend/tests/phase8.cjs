// Run with Playwright installed separately and available through NODE_PATH.
const { chromium, expect } = require('playwright/test')
const assert = require('node:assert/strict')
const { spawn, execFileSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const backendDirectory = path.resolve(__dirname, '../../backend')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'smooth-phase8-'))
let server, browser
const errors = []
const suffix = Date.now()
const names = { alice: `alice_${suffix}`, bob: `bob_${suffix}`, charlie: `charlie_${suffix}` }

async function startBackend() {
  server = spawn(path.join(backendDirectory, '.venv/bin/python'), ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8000'], {
    cwd: backendDirectory,
    env: { ...process.env, DATABASE_URL: `sqlite:///${temporary}/test.db`, SECRET_KEY: 'phase8-browser-test-only-secret-123456789', ACCESS_TOKEN_EXPIRE_MINUTES: '60', FRONTEND_ORIGIN: 'http://127.0.0.1:5173', UPLOAD_DIR: `${temporary}/uploads` },
    stdio: 'ignore',
  })
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error('Test backend could not start; port 8000 must be free')
    try { if ((await fetch('http://127.0.0.1:8000/')).ok) return } catch {}
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Backend startup timed out')
}

async function stopBackend() {
  if (!server || server.exitCode !== null) return
  const exited = new Promise(resolve => server.once('exit', resolve))
  server.kill('SIGTERM')
  await exited
}

async function newPage(context) {
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => {
    window.realtimeTest = { authenticated: 0, closed: 0, events: [], received: [], sentTyping: [], statuses: [] }
    window.imageUrls = { created: [], revoked: [] }
    const originalCreate = URL.createObjectURL.bind(URL), originalRevoke = URL.revokeObjectURL.bind(URL)
    URL.createObjectURL = blob => { const url = originalCreate(blob); window.imageUrls.created.push(url); return url }
    URL.revokeObjectURL = url => { window.imageUrls.revoked.push(url); originalRevoke(url) }
    const NativeWebSocket = window.WebSocket
    window.WebSocket = class extends NativeWebSocket {
      constructor(...args) {
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
  await page.getByRole('button', { name: 'Create account', exact: true }).click()
  await page.locator('#login-password').fill('password123')
  await page.getByRole('button', { name: 'Log in', exact: true }).click()
  await page.waitForFunction(() => window.realtimeTest.authenticated === 1)
}

async function select(page, name) {
  // Search fetches the current directory, including users registered after
  // this browser's initial directory request.
  await page.locator('#user-search').fill(name)
  await directoryRow(page, name).click()
  await expect(page.locator('#message-content')).toBeEnabled()
  await page.locator('#user-search').fill('')
}

function directoryRow(page, name) {
  return page.locator('.user-row').filter({ hasText: `@${name}` })
}

function recentRow(page, name) {
  return page.locator('.recent-row').filter({ hasText: `@${name}` })
}

async function openRecent(page, name) {
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

async function edit(page, content, replacement) {
  await messageRow(page, content).getByRole('button', { name: 'Edit', exact: true }).click()
  await page.getByLabel('Edit message text', { exact: true }).fill(replacement)
  const response = page.waitForResponse(r => r.request().method() === 'PATCH' && r.url().includes('/api/messages/'))
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  assert.equal((await response).status(), 200)
  await once(page, replacement)
}

async function remove(page, content, expected = 204) {
  page.once('dialog', dialog => dialog.accept())
  const response = page.waitForResponse(r => r.request().method() === 'DELETE' && r.url().includes('/api/messages/'))
  await messageRow(page, content).getByRole('button', { name: 'Delete', exact: true }).click()
  assert.equal((await response).status(), expected)
}

function photo(page, id) {
  return page.locator(`img[data-attachment-id="${id}"]`)
}

async function visiblePhoto(page, id) {
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
  await alice.locator('#user-search').fill(names.bob.toUpperCase())
  await expect(directoryRow(alice, names.bob)).toBeVisible()
  await alice.locator('#user-search').fill('')
  await select(alice, names.bob)
  await expect(recentRow(alice, names.bob).getByLabel('Last message preview')).toHaveText('No messages yet.')
  await select(bob, names.alice)
  const bobTab = await newPage(bobContext)
  await bobTab.waitForFunction(() => window.realtimeTest.authenticated === 1)
  await select(bobTab, names.alice)
  await expect(directoryRow(alice, names.bob)).toContainText('Online')
  await expect(directoryRow(bob, names.alice)).toContainText('Online')
  for (const page of [alice, bob]) await expect(page.getByLabel('Contact presence')).toHaveText('Online')
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
  await expect(directoryRow(bob, names.alice)).toContainText('Offline')
  await expect(typing).toHaveText('', { timeout: 5500 })
  alice = await newPage(aliceContext)
  await alice.waitForFunction(() => window.realtimeTest.authenticated === 1)
  await select(alice, names.bob)
  await expect(directoryRow(bob, names.alice)).toContainText('Online')
  await expect(alice.getByLabel('Contact presence')).toHaveText('Online')
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
  await expect(recentRow(alice, names.bob)).toContainText('Online')
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
  await expect(alice.getByLabel('Contact presence')).toHaveText('Online')
  assert.equal(await alice.evaluate(() => window.realtimeTest.received.filter(e => e.type === 'presence:update' && e.data.status === 'offline').length), 0)
  await bob.getByRole('button', { name: 'Log out' }).click()
  await bob.waitForFunction(() => window.realtimeTest.closed >= 1)
  await expect(alice.getByLabel('Contact presence')).toHaveText('Offline')
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
  await bob.getByRole('button', { name: 'Log in', exact: true }).click()
  await select(bob, names.alice)
  await once(bob, 'offline recipient')
  await status(alice, 'offline recipient', 'Read')
  await alice.reload()
  await alice.waitForFunction(() => window.realtimeTest.authenticated === 1)
  await select(alice, names.bob)
  await status(alice, 'offline recipient', 'Read')
  await status(alice, 'hello bob', 'Read')
  await expect(alice.getByLabel('Contact presence')).toHaveText('Online')
  console.log('PASS conversation isolation, logout socket cleanup, offline recipient history')

  await stopBackend()
  await alice.waitForFunction(() => window.realtimeTest.closed >= 1)
  await new Promise(resolve => setTimeout(resolve, 2500))
  await expect(alice.locator('#message-content')).toBeEnabled()
  await startBackend()
  await alice.waitForFunction(() => window.realtimeTest.authenticated >= 2)
  await bob.waitForFunction(() => window.realtimeTest.authenticated >= 3)
  for (const page of [alice, bob]) await expect(page.getByLabel('Contact presence')).toHaveText('Online')
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
  await expect(alice.getByRole('button', { name: 'Back to chats' })).toBeVisible()
  await alice.getByRole('button', { name: 'Back to chats' }).click()
  await expect(alice.getByLabel('Recent conversations')).toBeVisible()
  await expect(alice.locator('#message-content')).toHaveCount(0)
  await recentRow(alice, names.bob).focus()
  await alice.keyboard.press('Enter')
  await expect(alice.locator('#chat-title')).toHaveText(`@${names.bob}`)
  assert.equal(await alice.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
  await alice.getByRole('button', { name: 'Back to chats' }).click()
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
  await alice.getByRole('button', { name: 'Log out' }).click()
  await expect(directoryRow(bob, names.alice)).toContainText('Offline')
  for (let index = 1; index <= 4; index++) await send(bob, `offline unread ${index}`)
  await alice.locator('#login-username').fill(names.alice)
  await alice.locator('#login-password').fill('password123')
  await alice.getByRole('button', { name: 'Log in', exact: true }).click()
  await unread(alice, names.bob, 4)
  await alice.setViewportSize({ width: 375, height: 812 })
  await unread(alice, names.bob, 4)
  assert.equal(await alice.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
  await openRecent(alice, names.bob)
  await status(bob, 'offline unread 4', 'Read')
  await alice.getByRole('button', { name: 'Back to chats' }).click()
  await unread(alice, names.bob, 0)
  await alice.setViewportSize({ width: 1280, height: 800 })
  console.log('PASS unread 1/3, duplicate delivery, read clear across tabs, active/hidden chats, switching, refresh/restart, offline four-message recovery, mobile badges')

  await openRecent(alice, names.bob)
  const mutationTab = await newPage(aliceContext)
  await openRecent(mutationTab, names.bob)
  await send(alice, 'Hello Bbo mutation')
  await status(alice, 'Hello Bbo mutation', 'Read')
  await messageRow(alice, 'Hello Bbo mutation').getByRole('button', { name: 'Edit', exact: true }).click()
  await alice.getByLabel('Edit message text', { exact: true }).fill('Cancelled draft')
  await alice.getByRole('button', { name: 'Cancel', exact: true }).click()
  await once(alice, 'Hello Bbo mutation')
  await alice.route('**/api/messages/*', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"detail":"test unavailable"}' }))
  await messageRow(alice, 'Hello Bbo mutation').getByRole('button', { name: 'Edit', exact: true }).click()
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
  await expect(messageRow(bob, 'Hello Bob mutation').getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0)
  await expect(recentRow(alice, names.bob).getByLabel('Last message preview')).toHaveText('You: Hello Bob mutation')
  await edit(alice, 'Hello Bob mutation', 'Repeated edit mutation')
  await once(bob, 'Repeated edit mutation')
  await alice.reload()
  await openRecent(alice, names.bob)
  await once(alice, 'Repeated edit mutation')
  alice.once('dialog', dialog => dialog.dismiss())
  await messageRow(alice, 'Repeated edit mutation').getByRole('button', { name: 'Delete', exact: true }).click()
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

  await bob.getByRole('button', { name: 'Log out' }).click()
  await edit(alice, 'offline recipient', 'Offline edit persists')
  await send(alice, 'Removed while offline')
  await remove(alice, 'Removed while offline')
  await bob.locator('#login-username').fill(names.bob)
  await bob.locator('#login-password').fill('password123')
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
  await expect(messageRow(alice, 'Vacation photo').getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0)
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
  const removedUrls = await Promise.all([alice, bob, imageTab].map(page => photo(page, firstPhoto.attachment.id).getAttribute('src')))
  await remove(alice, 'Vacation photo')
  for (const [index, page] of [alice, bob, imageTab].entries()) {
    await expect(photo(page, firstPhoto.attachment.id)).toHaveCount(0)
    assert.ok(await page.evaluate(url => window.imageUrls.revoked.includes(url), removedUrls[index]))
  }
  assert.equal(fs.readdirSync(path.join(temporary, 'uploads/images')).length, 3)
  await remove(alice, 'Unread photo')
  await expect(recentRow(alice, names.bob).getByLabel('Last message preview')).toHaveText('You: Photo · WEBP photo')
  assert.equal(fs.readdirSync(path.join(temporary, 'uploads/images')).length, 2)
  await bob.getByRole('button', { name: 'Log out' }).click()
  const offlinePhoto = await sendPhoto(alice, jpeg, 'Offline photo')
  await status(alice, 'Offline photo', 'Sent')
  await bob.locator('#login-username').fill(names.bob)
  await bob.locator('#login-password').fill('password123')
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
  assert.equal(Number(count.trim()), 20)
  const receipts = execFileSync(path.join(backendDirectory, '.venv/bin/python'), ['-c', 'import sqlite3,sys; print(sqlite3.connect(sys.argv[1]).execute("SELECT count(*), count(DISTINCT message_id), count(delivered_at), count(read_at) FROM message_receipts").fetchone())', `${temporary}/test.db`], { encoding: 'utf8' })
  assert.equal(receipts.trim(), '(20, 20, 20, 20)')
  const edits = execFileSync(path.join(backendDirectory, '.venv/bin/python'), ['-c', 'import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); print(db.execute("SELECT count(*), min(content) FROM message_edits").fetchone()); print(db.execute("PRAGMA foreign_key_check").fetchall())', `${temporary}/test.db`], { encoding: 'utf8' })
  assert.equal(edits.trim(), "(1, 'Offline edit persists')\n[]")
  const attachments = execFileSync(path.join(backendDirectory, '.venv/bin/python'), ['-c', 'import sqlite3,sys,pathlib; root=pathlib.Path(sys.argv[1]); db=sqlite3.connect(root / "test.db"); names=[r[0] for r in db.execute("SELECT storage_name FROM message_attachments")]; print(len(names), len(list((root / "uploads/images").iterdir())), all((root / "uploads/images" / name).is_file() for name in names))', temporary], { encoding: 'utf8' })
  assert.equal(attachments.trim(), '3 3 True')
  assert.deepEqual(errors, [])
  console.log('PASS backend restart/reconnect, exactly 20 persisted messages, zero uncaught browser errors')
  console.log('PASS inactive Delivered, active Read, receipt-before-HTTP race, multiple-tab receipts, offline Sent/history Read, refresh persistence, forged acknowledgements, 20 persisted receipts')
}

main().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => {
  if (browser) await browser.close()
  await stopBackend()
  fs.rmSync(temporary, { recursive: true, force: true })
})
