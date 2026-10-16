import test from 'node:test'
import assert from 'node:assert/strict'
import { formatLastSeen, utcDate } from '../src/utils/formatLastSeen.js'
import { sameGroup } from '../src/utils/groupMessages.js'
import { reconcilePending, visiblePending } from '../src/utils/optimisticMessages.js'

process.env.TZ = 'UTC'
const now = Date.parse('2026-10-16T15:32:00Z')
for (const [age, result] of [
  [59000, 'last seen just now'], [60000, 'last seen 1 minute ago'],
  [59 * 60000, 'last seen 59 minutes ago'], [60 * 60000, 'last seen today at 14:32'],
]) test(`Last seen boundary ${age}`, () => assert.equal(formatLastSeen(new Date(now - age).toISOString(), now), result))
test('Unknown, invalid and future times never invent presence', () => {
  for (const value of [null, '', 'invalid', '2026-10-17T00:00:00Z']) assert.equal(formatLastSeen(value, now), 'offline')
})
test('UTC input and viewer-local yesterday', () => {
  assert.equal(utcDate('2026-10-16T14:32:00').toISOString(), '2026-10-16T14:32:00.000Z')
  assert.equal(formatLastSeen('2026-10-15T20:15:00', now), 'last seen yesterday at 20:15')
})
test('DST uses calendar yesterday and elapsed minute boundaries', () => {
  process.env.TZ = 'America/New_York'
  const fall = Date.parse('2026-11-01T07:30:00Z')
  assert.equal(formatLastSeen('2026-11-01T06:30:00Z', fall), 'last seen today at 01:30')
  assert.equal(formatLastSeen('2026-10-31T23:15:00Z', fall), 'last seen yesterday at 19:15')
  const spring = Date.parse('2026-03-08T07:30:00Z')
  assert.equal(formatLastSeen('2026-03-08T06:31:00Z', spring), 'last seen 59 minutes ago')
  assert.equal(formatLastSeen('2026-03-08T06:30:00Z', spring), 'last seen today at 01:30')
  process.env.TZ = 'UTC'
})
test('Grouping respects sender, calendar day, five minute boundary, gaps and backwards clocks', () => {
  const a = {sender_id:1, created_at:'2026-10-16T23:58:00Z'}
  assert.ok(sameGroup(a, {...a, created_at:'2026-10-16T23:59:00Z'}))
  assert.ok(!sameGroup(a, {...a, created_at:'2026-10-17T00:01:00Z'}))
  assert.ok(!sameGroup(a, {...a, sender_id:2}))
  assert.ok(!sameGroup(a, a, true))
  assert.ok(!sameGroup(a, {...a, created_at:'2026-10-16T23:57:00Z'}))
})
test('Pending presentation reconciles once without temporary canonical IDs or local-clock sorting', () => {
  const entries = [{localId:'uuid-a', client_message_id:'uuid-a', conversation_id:1}, {localId:'uuid-b', client_message_id:'uuid-b', conversation_id:2}]
  const server = [{id:23, client_message_id:'uuid-a', created_at:'2001-01-01T00:00:00Z'}]
  assert.deepEqual(visiblePending(entries, [], 1), [entries[0]])
  assert.deepEqual(visiblePending(entries, server, 1), [])
  assert.deepEqual(reconcilePending(entries, server), [entries[1]])
  assert.deepEqual(reconcilePending(reconcilePending(entries, server), server), [entries[1]])
  assert.deepEqual(reconcilePending([{...entries[0], serverId:23}], [], [23]), [])
  assert.equal('id' in entries[0], false)
})
