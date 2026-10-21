import test from 'node:test'
import assert from 'node:assert/strict'
import { initialPresence, presenceReducer as reduce } from '../src/utils/presenceState.js'
import { formatLastSeen } from '../src/utils/formatLastSeen.js'

const start = Date.parse('2026-10-17T20:54:00Z')
const iso = ms => new Date(ms).toISOString()
const update = (revision, status, ms, extra = {}) => ({ type: 'update', user_id: 2, revision, status, now: ms, server_time: iso(ms), ...extra })
const snapshot = (revision, ids, ms = start) => ({ type: 'snapshot', revision, ids, now: ms, server_time: iso(ms) })
const label = state => state.onlineIds.has(2) ? 'online' : formatLastSeen(state.lastSeen.get(2), state.now)

test('Offline timestamp newer than the 30s tick renders immediately in the same state update', () => {
  let state = reduce(initialPresence(), snapshot(1, [1, 2]))
  const stamp = iso(start + 5000)
  // Reproduces the exact previous bug with fully valid server data.
  assert.equal(formatLastSeen(stamp, state.now), 'offline')
  state = reduce(state, update(2, 'offline', start + 5001, { last_seen_at: stamp }))
  assert.equal(label(state), 'last seen just now')
  assert.equal(state.lastSeen.get(2), stamp)
  for (const [age, expected] of [[60000, 'last seen 1 minute ago'], [3599999, 'last seen 59 minutes ago']]) {
    state = reduce(state, { type: 'clock', now: start + 5000 + age })
    assert.equal(label(state), expected)
  }
})

test('Server clock corrects a fast client without fabricating a last-seen timestamp', () => {
  let state = reduce(initialPresence(), { ...snapshot(1, [2]), now: start + 3600000 })
  state = reduce(state, { ...update(2, 'offline', start + 5000, { last_seen_at: iso(start + 4999) }), now: start + 3605000 })
  assert.equal(label(state), 'last seen just now')
  state = reduce(state, { type: 'clock', now: start + 3665000 })
  assert.equal(label(state), 'last seen 1 minute ago')
})

test('Missing, invalid and genuinely future timestamps keep the offline fallback', () => {
  for (const last_seen_at of [null, undefined, 'invalid', iso(start + 3600000)]) {
    const state = reduce(initialPresence(), update(1, 'offline', start, { last_seen_at }))
    assert.equal(label(state), 'offline')
    if (!last_seen_at || last_seen_at === 'invalid') assert.equal(state.lastSeen.size, 0)
  }
})

test('Stale and duplicate online/offline updates cannot revert status, clock or last seen', () => {
  let state = reduce(initialPresence(), snapshot(1, [2]))
  state = reduce(state, update(3, 'offline', start + 5000, { last_seen_at: iso(start + 4999) }))
  assert.strictEqual(reduce(state, update(2, 'online', start)), state)
  state = reduce(state, update(4, 'online', start + 6000))
  for (const revision of [2, 3, 4, undefined]) {
    assert.strictEqual(reduce(state, update(revision, 'offline', start, { last_seen_at: iso(start - 10000) })), state)
  }
  assert.equal(label(state), 'online')
})

test('Snapshot watermark rejects old events for absent users; newer per-user state survives an older snapshot', () => {
  let state = reduce(initialPresence(), snapshot(10, [1]))
  assert.strictEqual(reduce(state, update(9, 'online', start)), state)
  state = reduce(state, update(12, 'online', start + 1000))
  state = reduce(state, snapshot(11, [1], start + 500))
  assert.equal(label(state), 'online')
  assert.strictEqual(reduce(state, snapshot(9, [])), state)
  state = reduce(state, update(13, 'offline', start + 2000, { last_seen_at: iso(start + 1999) }))
  state = reduce(state, snapshot(12, [1, 2], start + 1500))
  assert.equal(label(state), 'last seen just now')
})

test('Reconnect resets stream revisions after a server restart and retains reliable private details', () => {
  let state = reduce(initialPresence(), update(100, 'offline', start + 1000, { last_seen_at: iso(start + 999) }))
  state = reduce(state, { type: 'disconnect', now: start + 1100 })
  state = reduce(state, snapshot(1, [2], start + 1200))
  assert.equal(label(state), 'online')
  state = reduce(state, update(2, 'offline', start + 1300))
  assert.equal(label(state), 'last seen just now')
  assert.equal(state.lastSeen.get(2), iso(start + 999))
})

test('Refresh restores persisted last seen; slow HTTP details cannot revert newer realtime state or clock', () => {
  const stamp = iso(start + 4999)
  let state = reduce(initialPresence(), snapshot(7, [], start + 6000))
  state = reduce(state, { type: 'details', now: start + 6001, server_time: iso(start + 6000), users: [{ user_id: 2, last_seen_at: stamp, online: false }] })
  assert.equal(label(state), 'last seen just now')
  state = reduce(state, update(8, 'online', start + 7000))
  state = reduce(state, { type: 'details', now: start + 7100, server_time: iso(start), users: [{ user_id: 2, last_seen_at: iso(start - 100), online: false }] })
  assert.equal(label(state), 'online')
  assert.equal(state.lastSeen.get(2), stamp)
  assert.equal(state.now, start + 7100)
})

test('Legacy timestamp-free events never invent a timestamp', () => {
  let state = reduce(initialPresence(), { type: 'snapshot', ids: [2], now: start })
  state = reduce(state, { type: 'update', user_id: 2, status: 'offline', now: start + 5000 })
  assert.equal(label(state), 'offline')
  assert.equal(state.lastSeen.size, 0)
})
