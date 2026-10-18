// Uses the same real, isolated HTTP/WebSocket backend as phases 8/17/18.
const { chromium, expect } = require('playwright/test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const h = require('./phase8.cjs')
let browser
const output = process.env.HELIX_QA_DIR || path.join(require('node:os').tmpdir(), `helix-phase19-qa-${Date.now()}`)
async function closeMenu(page) {
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.waitForFunction(() => !history.state?.smoothOverlay)
}
async function assertViewport(page, width, height) {
  // VisualViewport updates are applied on the next animation frame. Keep the
  // same bounds, but observe the resulting layout rather than the resize task.
  await expect.poll(async () => {
    const layout = await page.evaluate(() => {
      const composer = document.querySelector('.chat-composer')?.getBoundingClientRect()
      return {width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,
        scrollHeight:document.documentElement.scrollHeight,visualHeight:visualViewport?.height,
        chatHeight:document.documentElement.style.getPropertyValue('--chat-height'),
        composer:composer && {x:composer.x,y:composer.y,width:composer.width,height:composer.height}}
    })
    const box = layout.composer
    return layout.width === width && layout.height === height
      && layout.scrollWidth <= layout.width && layout.scrollHeight <= layout.height
      && box && box.x >= 0 && box.y >= 0 && box.x + box.width <= width + 1 && box.y + box.height <= height + 1
      ? 'fits' : layout
  }, {message:`Composer and document fit the ${width}×${height} viewport after resize`}).toBe('fits')
}
async function main() {
  await h.startBackend()
  browser = await chromium.launch({ headless: true })
  const ac = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const bc = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const alice = await h.newPage(ac), bob = await h.newPage(bc)
  await h.registerAndLogin(alice, h.names.alice)
  await h.registerAndLogin(bob, h.names.bob)
  await expect(alice.locator('html')).toHaveAttribute('data-theme', 'dark')
  await h.navigate(alice, 'Settings')
  await alice.getByRole('button', { name: 'Switch to light theme' }).click()
  await expect(alice.locator('html')).toHaveAttribute('data-theme', 'light')
  await alice.reload()
  await h.navigate(alice, 'Settings')
  await expect(alice.getByRole('button', { name: 'Switch to dark theme' })).toBeVisible()
  await alice.getByRole('button', { name: 'Switch to dark theme' }).click()
  await h.select(alice, h.names.bob); await h.select(bob, h.names.alice)

  const input = alice.locator('#message-content')
  const response = alice.waitForResponse(r => r.url().endsWith('/messages') && r.request().method() === 'POST')
  await input.fill('Desktop Enter sends once')
  await input.press('Enter')
  const saved = await (await response).json()
  await expect(h.rowById(alice, saved.id)).toHaveCount(1)
  await h.status(alice, saved.content, 'Read')
  await input.fill('Line one'); await input.press('Shift+Enter'); await input.press('a')
  await expect(input).toHaveValue('Line one\na')
  await input.fill('')
  await h.rowById(alice, saved.id).locator('.message-text').click()
  await expect(alice.getByRole('dialog', { name: 'Message actions', exact: true })).toBeVisible()
  await closeMenu(alice)
  await h.openRecent(alice, h.names.bob)
  await expect(h.rowById(alice, saved.id)).toHaveCount(1)

  const incoming = await h.send(bob, 'A message from Bob')
  await expect(h.rowById(alice, incoming.id)).toHaveCount(1)
  const menu = await h.openMenu(alice, h.rowById(alice, incoming.id))
  await expect(menu.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0)
  await expect(menu.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0)
  await menu.getByRole('button', { name: 'Reply', exact: true }).click()
  await expect(alice.getByLabel('Reply composer')).toContainText(incoming.content)
  await expect(input).toBeFocused()
  await alice.getByRole('button', { name: 'Cancel reply' }).click()
  await expect(alice.getByLabel('Reply composer')).toHaveCount(0)
  console.log('PASS dark/light persistence, desktop Enter, one canonical row, permissions, reply focus and preview dismissal')

  fs.mkdirSync(output, { recursive: true })
  for (const width of [360, 390, 430, 1280]) {
    await alice.setViewportSize({ width, height: 800 })
    await assertViewport(alice, width, 800)
    await h.openMenu(alice, h.rowById(alice, saved.id))
    const dialog = alice.getByRole('dialog', { name: 'Message actions', exact: true })
    const box = await dialog.boundingBox()
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= 800)
    await alice.keyboard.press('Tab')
    assert.ok(await dialog.evaluate(el => el.contains(document.activeElement)))
    await alice.screenshot({ path: path.join(output, `${width}-context.png`) })
    await closeMenu(alice)
    await expect(h.rowById(alice, saved.id).locator('.message-bubble')).toBeFocused()
    await alice.screenshot({ path: path.join(output, `${width}-chat.png`) })
  }
  await alice.emulateMedia({ reducedMotion: 'reduce' })
  await h.openMenu(alice, h.rowById(alice, saved.id))
  assert.equal(await alice.getByRole('dialog').evaluate(el => getComputedStyle(el).animationDuration), '0s')
  await closeMenu(alice)

  const mc = await browser.newContext({ isMobile: true, hasTouch: true, viewport: { width: 390, height: 800 } })
  const mobile = await h.newPage(mc)
  await mobile.locator('#login-username').fill(h.names.alice)
  await mobile.locator('#login-password').fill('password123')
  await require('./captcha.cjs').ready(mobile)
  await mobile.getByRole('button', { name: 'Log in', exact: true }).click()
  await h.select(mobile, h.names.bob)
  const mobileInput = mobile.locator('#message-content')
  await expect(mobileInput).toBeEnabled()
  await mobileInput.fill('Mobile line one')
  await mobileInput.press('Enter')
  await expect(mobileInput).toHaveValue('Mobile line one\n')
  await expect(mobile.locator('[data-local-id]')).toHaveCount(0)
  await mobile.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(mobileInput).toHaveValue('')
  await mobileInput.focus()
  await mobile.setViewportSize({ width: 390, height: 390 })
  await assertViewport(mobile, 390, 390)
  await mobile.setViewportSize({ width: 390, height: 800 })

  const bubble = h.rowById(mobile, saved.id).locator('.message-bubble')
  await bubble.scrollIntoViewIfNeeded()
  await bubble.dispatchEvent('pointerdown', { pointerType: 'touch', pointerId: 1, isPrimary: true, clientX: 50, clientY: 300 })
  await bubble.dispatchEvent('pointermove', { pointerType: 'touch', pointerId: 1, isPrimary: true, clientX: 50, clientY: 345 })
  await bubble.dispatchEvent('pointerup', { pointerType: 'touch', pointerId: 1, isPrimary: true })
  await bubble.dispatchEvent('click')
  await expect(mobile.getByRole('dialog')).toHaveCount(0)
  await bubble.dispatchEvent('pointerdown', { pointerType: 'touch', pointerId: 2, isPrimary: true, clientX: 50, clientY: 300 })
  await expect(mobile.getByRole('dialog', { name: 'Message actions', exact: true })).toBeVisible()
  await bubble.dispatchEvent('pointerup', { pointerType: 'touch', pointerId: 2, isPrimary: true })
  await mobile.evaluate(() => history.back())
  await expect(mobile.getByRole('dialog')).toHaveCount(0)
  await expect(mobileInput).toBeVisible()
  await mobile.evaluate(() => history.back())
  await expect(mobile.locator('.chat-sidebar')).toBeVisible()
  await h.navigate(mobile, 'Chats')
  await h.openRecent(mobile, h.names.bob)
  await expect(mobileInput).toBeVisible()
  console.log('PASS mobile multiline/explicit send, simulated keyboard resize, scroll cancellation, long press, overlay and conversation browser-back')
  assert.deepEqual(h.errors, [])
  console.log(`PASS no uncaught browser errors; screenshots: ${output}`)
}
main().catch(async error => { console.error(error); process.exitCode = 1; await h.captureFailure(browser, error) }).finally(async () => {
  if (browser) await browser.close()
  await h.stopBackend()
  fs.rmSync(h.temporary, { recursive: true, force: true })
})
