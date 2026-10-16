export function utcDate(timestamp) {
  return new Date(typeof timestamp === 'string' && !/(Z|[+-]\d\d:\d\d)$/i.test(timestamp) ? `${timestamp}Z` : timestamp)
}
