// Run with Playwright installed separately and available through NODE_PATH.
const { chromium, expect } = require('playwright/test')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
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
    env: { ...process.env, DATABASE_URL: `sqlite:///${temporary}/test.db`, SECRET_KEY: 'phase8-browser-test-only-secret-123456789', ACCESS_TOKEN_EXPIRE_MINUTES: '60', FRONTEND_ORIGIN: 'http://127.0.0.1:5173' },
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
    window.realtimeTest = { authenticated: 0, closed: 0, events: [], received: [], sentTyping: [] }
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
  await directoryRow(page, name).click()
  await expect(page.locator('#message-content')).toBeEnabled()
}

function directoryRow(page, name) {
  return page.locator('.user-row').filter({ hasText: `@${name}` })
}

async function send(page, content) {
  await page.locator('#message-content').fill(content)
  const response = page.waitForResponse(r => r.url().endsWith('/messages') && r.request().method() === 'POST')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  assert.equal((await response).status(), 201)
}

async function once(page, content) {
  await expect(page.locator('.message-bubble').filter({ hasText: content })).toHaveCount(1)
}

async function main() {
  await startBackend()
  browser = await chromium.launch({ headless: true })
  const aliceContext = await browser.newContext(), bobContext = await browser.newContext(), charlieContext = await browser.newContext()
  let alice = await newPage(aliceContext)
  const bob = await newPage(bobContext), charlie = await newPage(charlieContext)
  await registerAndLogin(alice, names.alice)
  await registerAndLogin(bob, names.bob)
  await registerAndLogin(charlie, names.charlie)
  await alice.locator('#user-search').fill(names.bob.toUpperCase())
  await expect(directoryRow(alice, names.bob)).toBeVisible()
  await alice.locator('#user-search').fill('')
  await select(alice, names.bob)
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
  await send(alice, 'hello bob')
  for (const page of [alice, bob, bobTab]) await once(page, 'hello bob')
  await expect(typing).toHaveText('')
  await send(bob, 'hello alice')
  for (const page of [alice, bob, bobTab]) await once(page, 'hello alice')
  await bob.reload()
  await bob.waitForFunction(() => window.realtimeTest.authenticated === 1)
  await select(bob, names.alice)
  await once(bob, 'hello bob')
  await once(bob, 'hello alice')
  console.log('PASS registration, login, search, realtime both ways, multiple tabs, deduplication, refresh history')

  await select(alice, names.charlie)
  await send(bob, 'other conversation')
  await alice.waitForFunction(() => window.realtimeTest.events.some(m => m.content === 'other conversation'))
  await expect(alice.locator('.message-bubble')).toHaveCount(0)
  await select(alice, names.bob)
  await once(alice, 'other conversation')
  await bobTab.close()
  await expect(alice.getByLabel('Contact presence')).toHaveText('Online')
  assert.equal(await alice.evaluate(() => window.realtimeTest.received.filter(e => e.type === 'presence:update' && e.data.status === 'offline').length), 0)
  await bob.getByRole('button', { name: 'Log out' }).click()
  await bob.waitForFunction(() => window.realtimeTest.closed >= 1)
  await expect(alice.getByLabel('Contact presence')).toHaveText('Offline')
  const logoutEvents = await bob.evaluate(() => window.realtimeTest.events.length)
  await send(alice, 'offline recipient')
  await new Promise(resolve => setTimeout(resolve, 2300))
  assert.equal(await bob.evaluate(() => window.realtimeTest.events.length), logoutEvents)
  await bob.locator('#login-username').fill(names.bob)
  await bob.locator('#login-password').fill('password123')
  await bob.getByRole('button', { name: 'Log in', exact: true }).click()
  await select(bob, names.alice)
  await once(bob, 'offline recipient')
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
  // Confirm persisted count directly, including across server restart.
  const { execFileSync } = require('node:child_process')
  const count = execFileSync(path.join(backendDirectory, '.venv/bin/python'), ['-c', 'import sqlite3,sys; print(sqlite3.connect(sys.argv[1]).execute("SELECT count(*) FROM messages").fetchone()[0])', `${temporary}/test.db`], { encoding: 'utf8' })
  assert.equal(Number(count.trim()), 5)
  assert.deepEqual(errors, [])
  console.log('PASS backend restart/reconnect, exactly five persisted messages, zero uncaught browser errors')
}

main().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => {
  if (browser) await browser.close()
  await stopBackend()
  fs.rmSync(temporary, { recursive: true, force: true })
})
