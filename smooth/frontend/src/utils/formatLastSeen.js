export function utcDate(timestamp) {
  return new Date(typeof timestamp === 'string' && !/(Z|[+-]\d\d:\d\d)$/i.test(timestamp) ? `${timestamp}Z` : timestamp)
}

export function formatLastSeen(timestamp, now = Date.now()) {
  if (!timestamp) return 'offline'
  const date = utcDate(timestamp), today = new Date(now)
  const age = today - date
  if (!Number.isFinite(age) || age < 0) return 'offline'
  if (age < 60000) return 'last seen just now'
  if (age < 3600000) {
    const minutes = Math.floor(age / 60000)
    return `last seen ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`
  }
  const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(date)
  if (date.toDateString() === today.toDateString()) return `last seen today at ${time}`
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) return `last seen yesterday at ${time}`
  return `last seen ${new Intl.DateTimeFormat('en', { year: 'numeric', month: 'short', day: 'numeric' }).format(date)} at ${time}`
}
