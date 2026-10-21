// Real HTTP/WS races plus mobile and accessible context interactions.
const { chromium, expect } = require('playwright/test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const h = require('./phase8.cjs')
let browser
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve }); return { promise, release } }
async function api(page, path, method = 'GET', body) {
  const result = await page.evaluate(async ({path, method, body}) => {
    const response = await fetch(path, {method, headers:{Authorization:`Bearer ${localStorage.getItem('smooth_access_token')}`, ...(body ? {'Content-Type':'application/json'} : {})}, body:body ? JSON.stringify(body) : undefined})
    return {status:response.status, data:response.status === 204 ? null : await response.json()}
  }, {path, method, body})
  assert.ok(result.status >= 200 && result.status < 300, JSON.stringify(result))
  return result.data
}
const pending = page => page.locator('[data-local-id]')
const bubble = (page, id) => h.rowById(page, id).locator('.message-bubble')
async function submit(page, content) {
  await page.locator('#message-content').fill(content)
  await page.getByRole('button', {name:'Send', exact:true}).click()
}
async function assertOne(page, id, key) {
  await expect(h.rowById(page, id)).toHaveCount(1)
  await expect(page.locator(`[data-local-id="${key}"]`)).toHaveCount(0)
}
async function main() {
  await h.startBackend()
  browser = await chromium.launch({headless:true})
  const ac = await browser.newContext(), bc = await browser.newContext()
  const alice = await h.newPage(ac), bob = await h.newPage(bc)
  await h.registerAndLogin(alice, h.names.alice); await h.registerAndLogin(bob, h.names.bob)
  await h.select(alice, h.names.bob); await h.select(bob, h.names.alice)
  const cid = (await api(alice, '/api/conversations'))[0].id
  const base = `/api/conversations/${cid}/messages`
  let reactionGets = 0
  alice.on('request', request => { if (request.method() === 'GET' && /\/reactions$/.test(new URL(request.url()).pathname)) reactionGets++ })

  // No request may confirm before the pending bubble is presented.
  const allowCommit = gate(), committed = gate(), response = gate()
  let saved, clientId
  await alice.route('**' + base, async route => {
    if (route.request().method() !== 'POST') return route.continue()
    clientId = route.request().postDataJSON().client_message_id
    await allowCommit.promise
    const result = await route.fetch(); saved = await result.json(); committed.release()
    await response.promise
    await route.fulfill({response:result})
  })
  await submit(alice, 'Visible before persistence')
  await expect(pending(alice)).toHaveCount(1)
  await expect(pending(alice)).toContainText('Sending…')
  await expect(alice.locator('#message-content')).toHaveValue('Visible before persistence')
  await expect(alice.locator('[data-message-id]')).toHaveCount(0)
  const localId = await pending(alice).getAttribute('data-local-id')
  assert.match(localId, /^[0-9a-f-]{36}$/)
  allowCommit.release(); await committed.promise
  assert.equal(clientId, localId)
  await assertOne(alice, saved.id, localId) // WS + recovery precede held HTTP.
  response.release()
  await expect(alice.locator('#message-content')).toHaveValue('')
  await alice.unroute('**' + base)
  await h.status(alice, saved.content, 'Read')
  console.log('PASS pending DOM before HTTP commit; WS-before-HTTP canonical reconciliation')

  // REST-first: a delayed sync keeps a confirmed overlay until recovery installs it.
  const sync = gate()
  await alice.evaluate(() => { window.realtimeTest.dropNewMessage = true })
  await alice.route('**/api/conversations/*/sync?*', async route => { await sync.promise; await route.continue() })
  const restFirst = await h.send(alice, 'REST confirms before recovery')
  await expect(pending(alice)).toContainText('Sent')
  await expect(h.rowById(alice, restFirst.id)).toHaveCount(0)
  sync.release(); await alice.unroute('**/api/conversations/*/sync?*')
  await assertOne(alice, restFirst.id, restFirst.client_message_id)
  await alice.evaluate(() => { window.realtimeTest.dropNewMessage = false })

  // The server committed, but both response and socket echo are lost.
  let lost, attempts = []
  await alice.evaluate(() => { window.realtimeTest.dropNewMessage = true })
  await alice.route('**/api/conversations/*/sync?*', route => route.abort())
  await alice.route('**' + base, async route => {
    if (route.request().method() !== 'POST') return route.continue()
    attempts.push(route.request().postDataJSON().client_message_id)
    const result = await route.fetch(); lost = await result.json(); await route.abort()
  })
  await submit(alice, 'Committed response was lost')
  await expect(pending(alice)).toHaveAttribute('data-state', 'failed')
  await expect(alice.locator('#message-content')).toHaveValue('Committed response was lost')
  await alice.unroute('**' + base)
  await alice.route('**' + base, async route => { if (route.request().method() === 'POST') attempts.push(route.request().postDataJSON().client_message_id); await route.continue() })
  // Two clicks in the same task must share one in-flight retry.
  await pending(alice).getByRole('button', {name:'Retry message', exact:true}).evaluate(button => { button.click(); button.click() })
  await expect(pending(alice)).toHaveAttribute('data-state', 'sent')
  assert.deepEqual(attempts, [lost.client_message_id, lost.client_message_id])
  await alice.unroute('**/api/conversations/*/sync?*')
  await alice.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await assertOne(alice, lost.id, lost.client_message_id)
  await alice.unroute('**' + base)
  await alice.evaluate(() => { window.realtimeTest.dropNewMessage = false })
  assert.equal((await api(alice, base)).filter(message => message.client_message_id === lost.client_message_id).length, 1)
  console.log('PASS HTTP-first recovery; lost committed response; double retry uses one UUID and one persisted row')

  // A delayed create response must not undo a later authoritative edit/delete.
  for (const mutation of ['edit', 'delete']) {
    const didCommit = gate(), release = gate(); let original
    await alice.route('**' + base, async route => {
      if (route.request().method() !== 'POST') return route.continue()
      const result = await route.fetch(); original = await result.json(); didCommit.release(); await release.promise
      try { await route.fulfill({response:result}) } catch {}
    })
    await submit(alice, `Create then ${mutation}`); await didCommit.promise
    await expect(h.rowById(alice, original.id)).toHaveCount(1)
    if (mutation === 'edit') {
      await api(bob, '/api/auth/me')
      await api(alice, `/api/messages/${original.id}`, 'PATCH', {content:'Newer edit wins'})
      await expect(h.rowById(alice, original.id)).toContainText('Newer edit wins')
    } else {
      await api(alice, `/api/messages/${original.id}`, 'DELETE')
      await expect(h.rowById(alice, original.id)).toHaveCount(0)
    }
    release.release(); await alice.unroute('**' + base)
    await expect(alice.locator('#message-content')).toBeEnabled()
    if (mutation === 'edit') await expect(h.rowById(alice, original.id)).toContainText('Newer edit wins')
    else await expect(h.rowById(alice, original.id)).toHaveCount(0)
  }
  console.log('PASS held create response cannot overwrite a newer edit or resurrect a deletion')

  // Private media, failed upload retention, safe retry, and canonical photo-only surface.

  // Use the backend's verified fixture to avoid embedding malformed image bytes.
  const { execFileSync } = require('node:child_process')
  const path = require('node:path'), filename = path.join(h.temporary, 'phase18.png')
  execFileSync(path.join(h.backendDirectory, '.venv/bin/python'), ['-c','from PIL import Image; import sys; Image.new("RGB",(640,480),"coral").save(sys.argv[1])',filename])
  let photo, uploadId
  // Forwarding an intercepted multipart request can omit its native File.
  // Let Chromium transmit it, then lose the actual committed response instead.
  const uploadSession = await ac.newCDPSession(alice)
  const blockedSync = {urlPattern:'*/api/conversations/*/sync?*',requestStage:'Request'}
  let resolvePhoto, rejectPhoto
  const committedPhoto = new Promise((resolve,reject) => { resolvePhoto=resolve; rejectPhoto=reject })
  const uploadTimeout = setTimeout(() => rejectPhoto(new Error('Real image upload did not reach its response within 30 seconds')),30000)
  const intercept = event => {
    ;(async () => {
      if (event.responseStatusCode === undefined) {
        await uploadSession.send('Fetch.failRequest',{requestId:event.requestId,errorReason:'Failed'})
        return
      }
      assert.equal(event.request.method,'POST')
      assert.equal(event.responseStatusCode,201,'Real multipart upload must commit before its response is lost')
      const result = await uploadSession.send('Fetch.getResponseBody',{requestId:event.requestId})
      const message = JSON.parse(result.base64Encoded ? Buffer.from(result.body,'base64').toString('utf8') : result.body)
      assert.ok(Number.isSafeInteger(message.id))
      assert.equal(message.attachment.kind,'image')
      await uploadSession.send('Fetch.failRequest',{requestId:event.requestId,errorReason:'Failed'})
      resolvePhoto(message)
    })().catch(rejectPhoto)
  }
  uploadSession.on('Fetch.requestPaused',intercept)
  await alice.evaluate(() => { window.realtimeTest.dropNewMessage = true })
  try {
    await uploadSession.send('Fetch.enable',{patterns:[blockedSync,{urlPattern:'*'+base+'/image',requestStage:'Response'}]})
    ;[photo,uploadId] = await Promise.all([committedPhoto,(async () => {
      await alice.getByLabel('Choose image', {exact:true}).setInputFiles(filename)
      await expect(alice.getByAltText('Selected image preview')).toBeVisible()
      await alice.getByRole('button', {name:'Send', exact:true}).click()
      return await pending(alice).getAttribute('data-local-id')
    })()])
    await expect(pending(alice)).toHaveAttribute('data-state','failed')
    await expect(alice.getByAltText('Selected image preview')).toBeVisible()
    assert.equal(photo.client_message_id,uploadId)
    await uploadSession.send('Fetch.enable',{patterns:[blockedSync]})
    await pending(alice).getByRole('button', {name:'Retry message'}).click()
    await expect(pending(alice)).toHaveAttribute('data-state','sent')
  } finally {
    clearTimeout(uploadTimeout)
    uploadSession.off('Fetch.requestPaused',intercept)
    await uploadSession.send('Fetch.disable')
    await uploadSession.detach()
  }
  await alice.evaluate(() => { window.realtimeTest.dropNewMessage = false; document.dispatchEvent(new Event('visibilitychange')) })
  await assertOne(alice, photo.id, uploadId)
  await h.visiblePhoto(alice, photo.attachment.id)
  assert.equal((await api(alice, base)).filter(message => message.client_message_id === uploadId).length,1)
  const mediaStyle = await bubble(alice, photo.id).evaluate(element => ({padding:getComputedStyle(element).padding,background:getComputedStyle(element).backgroundColor}))
  assert.equal(mediaStyle.padding,'0px'); assert.equal(mediaStyle.background,'rgba(0, 0, 0, 0)')

  for (const width of [360,390,1280]) {
    await alice.setViewportSize({width,height:800})
    await alice.emulateMedia({reducedMotion:'reduce'})
    assert.equal(await alice.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true)
    await h.openMenu(alice,h.rowById(alice, saved.id))
    const menu = alice.getByRole('dialog',{name:'Message actions',exact:true})
    const box = await menu.boundingBox()
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= width + 1 && box.y + box.height <= 801)
    assert.equal(await menu.evaluate(element => getComputedStyle(element).animationDuration),'0s')
    await alice.keyboard.press('Tab')
    assert.ok(await menu.evaluate(element => element.contains(document.activeElement)))
    await alice.keyboard.press('Escape'); await expect(menu).toHaveCount(0)
    await expect(bubble(alice,saved.id)).toBeFocused()
    await h.visiblePhoto(alice, photo.attachment.id)
    await bubble(alice,photo.id).getByRole('button',{name:'Open photo',exact:true}).click()
    await expect(alice.getByRole('dialog',{name:'Photo viewer'})).toBeVisible()
    await alice.keyboard.press('Escape'); await expect(alice.getByRole('dialog')).toHaveCount(0)
  }
  await alice.setViewportSize({width:390,height:800})
  await alice.locator('#message-content').focus()
  await alice.setViewportSize({width:390,height:390})
  assert.ok((await alice.locator('#message-content').boundingBox()).y + (await alice.locator('#message-content').boundingBox()).height <= 390)
  await alice.setViewportSize({width:390,height:800})
  await h.openMenu(alice,h.rowById(alice,saved.id))
  await alice.evaluate(() => history.back())
  await expect(alice.getByRole('dialog')).toHaveCount(0)
  await alice.getByRole('button',{name:'Back',exact:true}).click()
  await h.openRecent(alice,h.names.bob)
  await expect(alice.locator('#message-content')).toBeVisible()
  console.log('PASS photo-only surface, private upload retry, viewer, 360/390px and desktop menus, focus/Escape/back/reduced motion')

  const bobTab = await h.newPage(bc)
  await bob.close()
  await expect(alice.getByLabel('Contact presence')).toHaveText('online')
  await bobTab.close()
  await expect(alice.getByLabel('Contact presence')).toHaveText('last seen just now')
  assert.equal(reactionGets,0)
  assert.deepEqual(h.errors,[])
  console.log('PASS final-socket last seen, zero per-message reaction GETs and zero uncaught browser errors')
}
main().catch(async error=>{console.error(error);process.exitCode=1;await h.captureFailure(browser,error)}).finally(async () => {
  if(browser) await browser.close()
  await h.stopBackend()
  fs.rmSync(h.temporary,{recursive:true,force:true})
})
