import test from 'node:test'
import assert from 'node:assert/strict'
import { positionMessageMenu, shouldSendOnEnter, movedBeyondTap } from '../src/utils/messageInteractions.js'

test('Message menu prefers above its anchor and flips below the top edge', () => {
  const viewport = { width: 390, height: 800 }, menu = { width: 288, height: 300 }
  const above = positionMessageMenu({ left: 250, top: 500, bottom: 550 }, menu, viewport)
  assert.equal(above.top, 192)
  assert.equal(above.left, 90)
  const below = positionMessageMenu({ left: 10, top: 40, bottom: 90 }, menu, viewport)
  assert.equal(below.top, 98)
  assert.equal(below.left, 12)
})

test('Menu fits the visual viewport with keyboard, panning, zoom, and tall error/confirmation surfaces', () => {
  for (const width of [180, 320, 360, 390, 430, 768, 1280, 1920]) {
    for (const height of [160, 300, 450, 800]) {
      for (const left of [0, 25]) for (const top of [0, 90]) {
        for (const anchor of [
          { left: -150, top: -300, bottom: -250 },
          { left: 0, top: 0, bottom: 50 },
          { left: width, top: height, bottom: height + 40 },
          { left: width / 2, top: height / 2, bottom: height / 2 + 40 },
        ]) {
          const menu = { width: 288, height: 600 }
          const position = positionMessageMenu(anchor, menu, { width, height, left, top })
          assert.ok(position.left >= left + 12)
          assert.ok(position.top >= top + 12)
          assert.ok(position.left + Math.min(menu.width, position.maxWidth) <= left + width - 12)
          assert.ok(position.top + Math.min(menu.height, position.maxHeight) <= top + height - 12)
        }
      }
    }
  }
})

test('Desktop Enter sends; Shift+Enter, mobile Enter, and IME composition preserve text', () => {
  const enter = { key: 'Enter', shiftKey: false, isComposing: false }
  assert.ok(shouldSendOnEnter(enter, false))
  assert.ok(!shouldSendOnEnter(enter, true))
  assert.ok(!shouldSendOnEnter({ ...enter, shiftKey: true }, false))
  assert.ok(!shouldSendOnEnter({ ...enter, isComposing: true }, false))
  assert.ok(!shouldSendOnEnter({ ...enter, keyCode: 229 }, false))
  assert.ok(!shouldSendOnEnter({ ...enter, key: 'a' }, false))
})

test('Scrolling and diagonal swipes cancel a message press; ordinary tap jitter does not', () => {
  const origin = { x: 30, y: 80 }
  assert.ok(!movedBeyondTap(origin, { x: 30, y: 80 }))
  assert.ok(!movedBeyondTap(origin, { x: 36, y: 88 }))
  assert.ok(movedBeyondTap(origin, { x: 38, y: 88 }))
  assert.ok(movedBeyondTap(origin, { x: 30, y: 91 }))
  assert.ok(movedBeyondTap(origin, { x: -20, y: 80 }))
})

test('Both themes keep normal text, placeholders, metadata, and send controls above 4.5:1 contrast', async () => {
  const { readFile } = await import('node:fs/promises')
  const css = await readFile(new URL('../src/styles/chat-tokens.css', import.meta.url), 'utf8')
  function luminance(hex) {
    const values = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4)
    return values.reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0)
  }
  for (const block of css.split(':root').slice(1)) {
    const colors = Object.fromEntries([...block.matchAll(/--([\w-]+): (#[0-9a-f]{6});/g)].map(match => [match[1], match[2]]))
    for (const [fg, bg] of [
      ['text-primary', 'surface-base'], ['text-secondary', 'surface-sidebar'], ['text-muted', 'surface-input'],
      ['text-muted', 'surface-base'], ['bubble-text', 'bubble-incoming'], ['bubble-text', 'bubble-outgoing'],
      ['metadata', 'bubble-incoming'], ['metadata', 'bubble-outgoing'], ['accent-ink', 'accent'],
    ]) {
      const [low, high] = [luminance(colors[fg]), luminance(colors[bg])].sort((a, b) => a - b)
      assert.ok((high + .05) / (low + .05) >= 4.5, `${block.includes('data-theme') ? 'light' : 'dark'}: ${fg} on ${bg}`)
    }
  }
})
