// Reuses the authenticated browser harness; starts only isolated test data.
const { chromium, expect } = require('playwright/test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const h = require('./phase8.cjs')
let browser
const dbPath = `${h.temporary}/test.db`

async function api(page, endpoint, method = 'GET', body) {
  const result = await page.evaluate(async ({ endpoint, method, body }) => {
    const response = await fetch(endpoint, { method, headers: { Authorization: `Bearer ${localStorage.getItem('smooth_access_token')}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
    return { status: response.status, data: response.status === 204 ? null : await response.json() }
  }, { endpoint, method, body })
  assert.ok(result.status >= 200 && result.status < 300, JSON.stringify(result))
  return result.data
}
function sql(program, ...args) {
  return execFileSync(path.join(h.backendDirectory, '.venv/bin/python'), ['-c', program, dbPath, ...args.map(String)], { encoding: 'utf8' }).trim()
}
const rows = page => page.locator('.chat-history [data-message-id]')
async function anchor(page) {
  return page.locator('.chat-history').evaluate(element => {
    const top = element.getBoundingClientRect().top
    const row = [...element.querySelectorAll('[data-message-id]')].find(row => row.getBoundingClientRect().top >= top)
    return row && { id: Number(row.dataset.messageId), offset: row.getBoundingClientRect().top - top }
  })
}
async function stable(page, before) {
  const after = await page.locator(`[data-message-id="${before.id}"]`).evaluate(row => row.getBoundingClientRect().top - row.closest('.chat-history').getBoundingClientRect().top)
  assert.ok(Math.abs(after - before.offset) < 3, `Scroll anchor moved ${after - before.offset}px`)
}
async function top(page) {
  await page.locator('.chat-history').evaluate(element => { element.scrollTop = 100 })
}
async function latest(page) {
  const jump = page.getByRole('button', { name: /Jump to latest/ })
  if (await jump.count()) await jump.click()
  await expect(page.getByText('Updating messages...', { exact: true })).toHaveCount(0)
}
async function settled(page) {
  await expect(page.getByText('Updating messages...', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('alert')).toHaveCount(0)
}

async function loadOlder(page) {
  const previousFirst = await rows(page).first().getAttribute('data-message-id')
  const response = page.waitForResponse(response => response.request().method() === 'GET' && response.url().includes('/messages/page?'))
  await page.getByRole('button', { name: 'Load older messages', exact: true }).click()
  assert.equal((await response).status(), 200)
  await expect(rows(page).first()).not.toHaveAttribute('data-message-id', previousFirst)
  await settled(page)
}

async function main() {
  await h.startBackend()
  browser = await chromium.launch({ headless: true })
  const aContext = await browser.newContext(), bContext = await browser.newContext(), cContext = await browser.newContext()
  const alice = await h.newPage(aContext), bob = await h.newPage(bContext), charlie = await h.newPage(cContext)
  await h.registerAndLogin(alice, h.names.alice); await h.registerAndLogin(bob, h.names.bob); await h.registerAndLogin(charlie, h.names.charlie)
  await h.select(alice, h.names.bob)
  const cid = (await api(alice, '/api/conversations'))[0].id
  const base = `/api/conversations/${cid}`
  const bobId = (await api(bob, '/api/auth/me')).id
  const aliceId = (await api(alice, '/api/auth/me')).id
  sql(`import sqlite3,sys
c=sqlite3.connect(sys.argv[1]); cid,a,b=map(int,sys.argv[2:])
c.executemany("INSERT INTO messages(id,conversation_id,sender_id,content,created_at) VALUES(?,?,?,?,?)", [(i,cid,a,'History '+str(i),'2025-01-01 00:00:00.000000') for i in range(1,10001)])
c.executemany("INSERT INTO message_receipts(message_id,recipient_id) VALUES(?,?)", [(i,b) for i in range(1,10001)])
c.commit()`, cid, aliceId, bobId)
  let legacyHistory = 0, reactionGets = 0
  const pageSizes = [], contextSizes = []
  alice.on('request', request => {
    if (request.method() === 'GET' && /\/messages$/.test(new URL(request.url()).pathname)) legacyHistory++
    if (request.method() === 'GET' && /\/reactions$/.test(new URL(request.url()).pathname)) reactionGets++
  })
  alice.on('response', async response => {
    try {
      if (response.request().method() === 'GET' && response.url().includes('/messages/page?')) pageSizes.push((await response.json()).items.length)
      if (response.url().endsWith('/context')) contextSizes.push((await response.json()).items.length)
    } catch {}
  })
  // Direct SQL fixtures have no sync events. Reload explicitly; selecting the
  // already-active chat now preserves its mounted timeline and scroll position.
  await alice.reload()
  await h.select(alice, h.names.bob)
  await expect(rows(alice)).toHaveCount(30)
  assert.equal(await rows(alice).first().getAttribute('data-message-id'), '9971')
  assert.equal(await rows(alice).last().getAttribute('data-message-id'), '10000')
  await h.select(bob, h.names.alice)
  await expect.poll(async () => (await api(bob, '/api/conversations'))[0].unread_count).toBe(0)
  await h.status(alice, 'History 10000', 'Read')
  assert.equal(sql('import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(c.execute("SELECT count(*) FROM conversation_events WHERE kind=\'receipts\'").fetchone()[0])'), '1')
  await top(alice)
  const initialAnchor = await anchor(alice)
  await loadOlder(alice)
  await expect(rows(alice)).toHaveCount(60)
  await settled(alice); await stable(alice, initialAnchor)
  for (let i = 0; i < 7; i++) {
    await top(alice)
    const before = await anchor(alice)
    await loadOlder(alice)
    await settled(alice); await stable(alice, before)
  }
  assert.equal(await rows(alice).count(), 180)
  const ids = await rows(alice).evaluateAll(rows => rows.map(row => Number(row.dataset.messageId)))
  assert.equal(new Set(ids).size, ids.length)
  assert.equal(reactionGets, 0); assert.equal(legacyHistory, 0)
  console.log('PASS 10,000-message initial 30, chronological older pages, 180-component cap, no duplicate IDs or reaction GET storm, partial-history bulk read')

  await top(alice)
  const beforeIncoming = await anchor(alice)
  const incoming = await api(bob, base + '/messages', 'POST', { content: 'Incoming while reading history' })
  await expect(alice.getByRole('button', { name: /1 new message.*Jump to latest/ })).toBeVisible()
  await settled(alice); await stable(alice, beforeIncoming)
  await latest(alice)
  await expect(h.rowById(alice, incoming.id)).toContainText(incoming.content)
  assert.equal(await rows(alice).count(), 30)
  assert.ok(await alice.locator('.chat-history').evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight < 64))
  await top(alice)
  const beforeEdit = await anchor(alice)
  await api(alice, '/api/messages/9975', 'PATCH', { content: 'Edited above anchor\nwith another line\nand another' })
  await expect(h.rowById(alice, 9975)).toContainText('Edited above anchor')
  await settled(alice); await stable(alice, beforeEdit)
  const beforeDelete = await anchor(alice)
  await api(alice, '/api/messages/9975', 'DELETE')
  await expect(h.rowById(alice, 9975)).toHaveCount(0)
  await settled(alice); await stable(alice, beforeDelete)
  const quoted = await api(bob, base + '/messages', 'POST', { content: 'Quote oldest message', reply_to_message_id: 1 })
  await expect(h.rowById(alice, quoted.id)).toBeAttached()
  await h.rowById(alice, quoted.id).getByLabel('Reply preview').click()
  await expect(h.rowById(alice, 1)).toHaveAttribute('data-highlighted', 'true')
  await expect(h.rowById(alice, 1)).toBeFocused()
  assert.ok(await rows(alice).count() <= 61)
  await expect(alice.getByRole('button', { name: 'Load messages in this gap' })).toBeVisible()
  assert.ok(contextSizes.every(size => size <= 31))
  const beforeQuotedChange = await anchor(alice)
  await api(alice, '/api/messages/1', 'PATCH', { content: 'Oldest changed again' })
  await expect(h.rowById(alice, quoted.id).getByLabel('Reply preview')).toContainText('Oldest changed again')
  await settled(alice); await stable(alice, beforeQuotedChange)
  console.log('PASS anchor preservation during prepend/incoming/edit/delete, new-message indicator, latest action, bounded unloaded reply context and live previews')

  await latest(alice)
  await settled(alice)
  await h.reply(alice, 10000)
  const authBefore = await alice.evaluate(() => window.realtimeTest.authenticated)
  await alice.route('**/api/conversations/*/sync?*', route => route.abort())
  await alice.evaluate(() => { window.realtimeTest.pauseRealtime = true; window.realtimeTest.socket.close() })
  await api(alice, '/api/messages/10000', 'PATCH', { content: 'Offline committed edit' })
  await api(alice, '/api/messages/9999', 'DELETE')
  await api(bob, '/api/messages/10000/reactions', 'POST', { emoji: '❤️' })
  const missed = []
  for (let i = 0; i < 4; i++) missed.push(await api(bob, base + '/messages', 'POST', { content: `Offline new ${i}` }))
  await alice.unroute('**/api/conversations/*/sync?*')
  await alice.evaluate(() => { window.realtimeTest.pauseRealtime = false })
  await alice.waitForFunction(before => window.realtimeTest.authenticated > before, authBefore, { timeout: 35000 })
  await expect(h.rowById(alice, 10000)).toContainText('Offline committed edit')
  await expect(alice.getByLabel('Reply composer')).toContainText('Offline committed edit')
  await alice.getByLabel('Cancel reply', { exact: true }).click()
  await expect(h.rowById(alice, 9999)).toHaveCount(0)
  for (const message of missed) await expect(h.rowById(alice, message.id)).toContainText(message.content)
  await h.reaction(alice, 10000, 'heart', 1, false)
  const aTab = await h.newPage(aContext)
  await h.openRecent(aTab, h.names.bob)
  await expect(h.rowById(aTab, 10000)).toContainText('Offline committed edit')
  const beforeRestart = await Promise.all([alice, aTab].map(page => page.evaluate(() => window.realtimeTest.authenticated)))
  await h.stopBackend(); await h.startBackend()
  const restarted = await api(bob, base + '/messages', 'POST', { content: 'Recovered after backend restart' })
  for (const [i, page] of [alice, aTab].entries()) {
    await page.waitForFunction(before => window.realtimeTest.authenticated > before, beforeRestart[i], { timeout: 35000 })
    await expect(h.rowById(page, restarted.id)).toContainText(restarted.content)
  }
  await aTab.close()
  console.log('PASS socket disconnect, four missed messages, offline edit/delete/reaction recovery, backend restart, multiple tabs')

  const historyTab = await h.newPage(aContext)
  let releaseHistory, capturedHistory
  const heldHistory = new Promise(resolve => { releaseHistory = resolve })
  const historyCaptured = new Promise(resolve => { capturedHistory = resolve })
  await historyTab.route('**/api/conversations/*/messages/page?*', async route => {
    const response = await route.fetch(); capturedHistory(); await heldHistory
    try { await route.fulfill({ response }) } catch {}
  })
  const opening = h.openRecent(historyTab, h.names.bob)
  await historyCaptured
  await historyTab.evaluate(() => window.realtimeTest.socket.close())
  await api(alice, '/api/messages/10000', 'PATCH', { content: 'Changed during initial reconnect' })
  releaseHistory(); await opening
  await expect(h.rowById(historyTab, 10000)).toContainText('Changed during initial reconnect')
  await historyTab.unroute('**/api/conversations/*/messages/page?*')
  // A held, obsolete Bob snapshot must never appear in Charlie's conversation.
  await h.select(historyTab, h.names.charlie)
  let releaseSwitch, capturedSwitch
  const heldSwitch = new Promise(resolve => { releaseSwitch = resolve })
  const switchCaptured = new Promise(resolve => { capturedSwitch = resolve })
  await historyTab.route('**/api/conversations/*/messages/page?*', async route => {
    const response = await route.fetch(); capturedSwitch(); await heldSwitch
    try { await route.fulfill({ response }) } catch {}
  })
  await historyTab.locator('.recent-row').filter({ hasText: h.names.bob }).click()
  await switchCaptured
  const switching = h.select(historyTab, h.names.charlie)
  releaseSwitch(); await switching
  await expect(rows(historyTab)).toHaveCount(0)
  await expect(historyTab.locator('#chat-title')).toHaveText('@' + h.names.charlie)
  await historyTab.close()

  // A delayed mutation response must not replace a newer personalized snapshot.
  let releaseAction, capturedAction
  const heldAction = new Promise(resolve => { releaseAction = resolve })
  const actionCaptured = new Promise(resolve => { capturedAction = resolve })
  await alice.route('**/api/messages/10000/reactions', async route => {
    if (route.request().method() !== 'POST') return route.continue()
    const response = await route.fetch(); capturedAction(); await heldAction
    try { await route.fulfill({ response }) } catch {}
  })
  const choosing = h.chooseReaction(alice, 10000, 'thumbs up')
  await actionCaptured
  await api(bob, '/api/messages/10000/reactions', 'POST', { emoji: '👍' })
  await expect(h.rowById(alice, 10000).getByRole('group', { name: 'Message reactions' }).getByRole('button', { name: /^2 thumbs up/ })).toBeAttached()
  releaseAction(); await choosing
  await alice.unroute('**/api/messages/10000/reactions')
  await h.reaction(alice, 10000, 'thumbs up', 2, true)
  const beforeDuplicate = await rows(alice).count()
  await alice.evaluate(message => {
    for (let i = 0; i < 3; i++) window.realtimeTest.socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'message:new', data: message }) }))
  }, restarted)
  await settled(alice)
  assert.equal(await rows(alice).count(), beforeDuplicate)
  console.log('PASS reconnect during held initial snapshot, aborting fast conversation switches, stale reaction action response, duplicate socket hints')

  await alice.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')) })
  const hidden = await api(bob, base + '/messages', 'POST', { content: 'Hidden conversation remains unread' })
  await expect(h.rowById(alice, hidden.id)).toBeAttached()
  await expect.poll(async () => (await api(alice, '/api/conversations'))[0].unread_count).toBe(1)
  await alice.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')) })
  await expect.poll(async () => (await api(alice, '/api/conversations'))[0].unread_count).toBe(0)

  const filename = path.join(h.temporary, 'lazy.png')
  execFileSync(path.join(h.backendDirectory, '.venv/bin/python'), ['-c', 'from PIL import Image; import sys; Image.new("RGB",(640,480),"coral").save(sys.argv[1])', filename])
  const photoIds = []
  for (let i = 0; i < 10; i++) {
    const response = await fetch(`http://127.0.0.1:8000${base}/messages/image`, {
      method: 'POST', headers: { Authorization: 'Bearer ' + await bob.evaluate(() => localStorage.getItem('smooth_access_token')) },
      body: (() => { const form = new FormData(); form.append('file', new Blob([fs.readFileSync(filename)], { type: 'image/png' }), 'lazy.png'); return form })(),
    })
    assert.equal(response.status, 201); photoIds.push((await response.json()).attachment.id)
  }
  const lazyTab = await h.newPage(aContext)
  let downloads = 0
  lazyTab.on('request', request => { if (request.url().includes('/api/attachments/')) downloads++ })
  await h.openRecent(lazyTab, h.names.bob)
  await expect(lazyTab.locator('[data-attachment-placeholder]')).toHaveCount(10)
  await h.visiblePhoto(lazyTab, photoIds.at(-1))
  assert.ok(downloads < 6, `Downloaded ${downloads} of 10 initially offscreen photos`)
  const visibleUrl = await lazyTab.locator(`img[data-attachment-id="${photoIds.at(-1)}"]`).getAttribute('src')
  const beforeDownloads = downloads
  await api(bob, '/api/messages/10000/reactions', 'POST', { emoji: '😂' })
  await settled(lazyTab)
  assert.equal(downloads, beforeDownloads)
  assert.equal(await lazyTab.locator(`img[data-attachment-id="${photoIds.at(-1)}"]`).getAttribute('src'), visibleUrl)
  await h.visiblePhoto(lazyTab, photoIds[0])
  await expect.poll(() => lazyTab.evaluate(url => window.imageUrls.revoked.includes(url), visibleUrl)).toBe(true)
  await lazyTab.setViewportSize({ width: 375, height: 812 })
  await lazyTab.emulateMedia({ reducedMotion: 'reduce' })
  assert.equal(await lazyTab.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await top(lazyTab)
  const mobileAnchor = await anchor(lazyTab)
  const olderButton = lazyTab.getByRole('button', { name: 'Load older messages', exact: true })
  const oldFirst = await rows(lazyTab).first().getAttribute('data-message-id')
  const mobileResponse = lazyTab.waitForResponse(response => response.request().method() === 'GET' && response.url().includes('/messages/page?'))
  await olderButton.focus(); await lazyTab.keyboard.press('Enter')
  assert.equal((await mobileResponse).status(), 200)
  await expect(rows(lazyTab).first()).not.toHaveAttribute('data-message-id', oldFirst)
  await settled(lazyTab); await stable(lazyTab, mobileAnchor)
  assert.equal(await lazyTab.locator('.auth-input').first().evaluate(element => getComputedStyle(element).transitionDuration), '0s')
  await lazyTab.reload()
  await lazyTab.getByRole('button', { name: /@.*bob/ }).first().click()
  await expect(rows(lazyTab)).toHaveCount(30)
  await lazyTab.close()
  assert.equal(reactionGets, 0); assert.equal(legacyHistory, 0)
  assert.ok(pageSizes.every(size => size <= 30))
  assert.deepEqual(h.errors, [])
  assert.equal(sql('import sqlite3,sys; print(sqlite3.connect(sys.argv[1]).execute("PRAGMA foreign_key_check").fetchall())'), '[]')
  console.log('PASS hidden/read visibility, image lazy loading/cache/URL revocation, mobile anchor/keyboard/reduced motion, refresh persistence, no uncaught browser errors')

  // A retained composer target stays current even after its row is evicted and
  // its mutation frame is missed; recovery requests its state with the window.
  await latest(alice)
  await h.reply(alice, 10000)
  for (let i = 0; i < 7; i++) { await top(alice); await loadOlder(alice) }
  await expect(h.rowById(alice, 10000)).toHaveCount(0)
  await alice.route('**/api/conversations/*/sync?*', route => route.abort())
  const closeToHideMutations = () => alice.evaluate(() => { window.realtimeTest.pauseRealtime = true; window.realtimeTest.socket.close() })
  await closeToHideMutations()
  await api(alice, '/api/messages/10000', 'DELETE')
  await alice.unroute('**/api/conversations/*/sync?*')
  await alice.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect(alice.getByLabel('Reply composer')).toHaveCount(0)
  await alice.evaluate(() => { window.realtimeTest.pauseRealtime = false; window.dispatchEvent(new Event('online')) })

  await h.select(alice, h.names.charlie)
  const recoveryCid = (await api(alice, '/api/conversations')).find(conversation => conversation.other_user.username === h.names.charlie).id
  const recoveryBase = `/api/conversations/${recoveryCid}`
  const charlieId = (await api(charlie, '/api/auth/me')).id
  const seeded = JSON.parse(sql(`import sqlite3,sys,json
c=sqlite3.connect(sys.argv[1]); cid,sender,recipient=map(int,sys.argv[2:]); start=c.execute('SELECT max(id) FROM messages').fetchone()[0]+1
ids=list(range(start,start+60))
c.executemany('INSERT INTO messages(id,conversation_id,sender_id,content,created_at) VALUES(?,?,?,?,?)', [(i,cid,sender,'Recovery history '+str(i),'2025-01-01 00:00:00.'+str(60-index).zfill(6)) for index,i in enumerate(ids)])
c.executemany('INSERT INTO message_receipts(message_id,recipient_id) VALUES(?,?)', [(i,recipient) for i in ids]); c.commit(); print(json.dumps(ids))`, recoveryCid, charlieId, aliceId))
  await h.select(alice, h.names.charlie)
  await expect(rows(alice)).toHaveCount(30)
  await expect(rows(alice).first()).toHaveAttribute('data-message-id', String(seeded[29]))
  await expect(rows(alice).last()).toHaveAttribute('data-message-id', String(seeded[0]))
  await alice.route('**/api/conversations/*/sync?*', route => route.abort())
  for (const id of seeded.slice(0, 30)) await api(charlie, `/api/messages/${id}`, 'DELETE')
  await alice.unroute('**/api/conversations/*/sync?*')
  await alice.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect(rows(alice).last()).toHaveAttribute('data-message-id', String(seeded[30]))
  await expect(rows(alice)).toHaveCount(30)
  await expect(alice.getByRole('button', { name: 'Load older messages', exact: true })).toHaveCount(0)

  await alice.route('**/api/conversations/*/sync?*', route => route.abort())
  const retained = await api(charlie, recoveryBase + '/messages', 'POST', { content: 'Recovered across retention gap' })
  sql(`import sqlite3,sys
c=sqlite3.connect(sys.argv[1]); cid=int(sys.argv[2]); c.execute('BEGIN IMMEDIATE')
head=c.execute('SELECT head FROM conversation_sync_state WHERE conversation_id=?',(cid,)).fetchone()[0]
c.execute('UPDATE conversation_sync_state SET floor=? WHERE conversation_id=?',(head,cid))
c.execute('DELETE FROM conversation_events WHERE conversation_id=? AND id<=?',(cid,head)); c.commit()`, recoveryCid)
  let sawGap = false
  alice.on('response', response => { if (response.url().includes(`/api/conversations/${recoveryCid}/sync?`) && response.status() === 409) sawGap = true })
  await alice.unroute('**/api/conversations/*/sync?*')
  await alice.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect(h.rowById(alice, retained.id)).toContainText(retained.content)
  await settled(alice)
  assert.equal(sawGap, true)
  let expiredOnce = false
  await alice.route('**/api/conversations/*/sync?*', route => {
    if (expiredOnce) return route.continue()
    expiredOnce = true
    return route.fulfill({ status: 410, contentType: 'application/json', body: '{"detail":"Cursor expired"}' })
  })
  await alice.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect.poll(() => expiredOnce).toBe(true)
  await settled(alice)
  await alice.unroute('**/api/conversations/*/sync?*')

  // Drop one frame without disconnecting: the visible timeline's bounded HTTP
  // recovery must find it even though the socket appears healthy.
  await alice.evaluate(() => { window.realtimeTest.dropNewMessage = true })
  const dropped = await api(charlie, recoveryBase + '/messages', 'POST', { content: 'Recovered a dropped live frame' })
  await expect(h.rowById(alice, dropped.id)).toContainText(dropped.content, { timeout: 20000 })
  await alice.evaluate(() => { window.realtimeTest.dropNewMessage = false })
  assert.deepEqual(h.errors, [])
  console.log('PASS evicted/offline reply target deletion, sub-millisecond chronological ordering, deleted-window recovery, retention-gap reset, expired-cursor reset, dropped-frame recovery on a healthy socket')
}

main().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => {
  if (browser) await browser.close()
  await h.stopBackend()
  fs.rmSync(h.temporary, { recursive: true, force: true })
})
