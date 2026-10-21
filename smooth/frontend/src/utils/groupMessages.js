import { utcDate } from './formatLastSeen.js'
const formatter = new Intl.DateTimeFormat('en', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
export function sameGroup(a, b, gap = false) {
  if (!a || !b || gap || a.sender_id !== b.sender_id) return false
  const first = utcDate(a.created_at), last = utcDate(b.created_at)
  return first.toDateString() === last.toDateString() && last - first >= 0 && last - first <= 300000
}
export function dayLabel(timestamp) {
  return formatter.format(utcDate(timestamp))
}
