import { useCallback, useEffect, useRef, useState } from 'react'
import { getMessagePage, getMessageContext, getOrCreateConversation, synchronize, markConversationRead, mergeReceipt } from '../services/api.js'

export const TIMELINE_LIMIT = 180
const microseconds = timestamp => Number((timestamp.match(/\.(\d+)/)?.[1] || '').padEnd(6, '0').slice(0, 6))
// Date.parse truncates Python's sub-millisecond precision. Preserve that part
// before using the ID tie-breaker so client windows match SQL cursor ordering.
const compare = (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)
  || microseconds(a.created_at) - microseconds(b.created_at) || a.id - b.id
const key = message => ({ id: message.id, created_at: message.created_at })

// Explicit bounded windows keep both mounted components and retained message
// state small. Cursors allow revisiting evicted history in either direction.
export default function useTimeline({ token, selectedUser, initialConversation, onConversationOpened,
  onUnauthorized, subscribeToSync, beforeChange, atBottom, onPersistedRead, retryAttempt,
  trackedIds, onReconciled, visible = true }) {
  const [messages, setMessages] = useState([])
  const [conversation, setConversation] = useState(null)
  const [stage, setStage] = useState('opening')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [syncError, setSyncError] = useState('')
  const [hasOlder, setHasOlder] = useState(false)
  const [hasNewer, setHasNewer] = useState(false)
  const [ranges, setRanges] = useState([])
  const [newCount, setNewCount] = useState(0)
  const [navigationId, setNavigationId] = useState(null)
  const session = useRef(null)
  const tracked = useRef([])
  tracked.current = trackedIds
  const viewVisible = useRef(visible)
  viewVisible.current = visible

  const install = useCallback((s, incoming, missing = [], reason = 'sync', page = null, targetId = null) => {
    if (!s.active) return
    const anchor = beforeChange(reason)
    const old = s.messages
    const replacing = ['latest', 'reset'].includes(reason)
    const map = new Map((replacing ? [] : old).map(message => [message.id, message]))
    if (replacing) { s.older = false; s.newer = false; s.ranges = [] }
    for (const id of missing) map.delete(id)
    for (const message of incoming) {
      const previous = map.get(message.id)
      if (previous && (previous._seq ?? -1) > (message._seq ?? -1)) continue
      map.set(message.id, { ...message, ...mergeReceipt(previous, message) })
    }
    let merged = [...map.values()].sort(compare)
    if (merged.length > TIMELINE_LIMIT) {
      let start = 0
      if (reason === 'context') start = Math.max(0, merged.findIndex(message => message.id === targetId) - TIMELINE_LIMIT / 2)
      else if (reason === 'older') start = Math.max(0, merged.findIndex(message => message.id === anchor?.id) + 12 - TIMELINE_LIMIT)
      else if (reason === 'newer' || atBottom.current) start = merged.length - TIMELINE_LIMIT
      merged = merged.slice(start, start + TIMELINE_LIMIT)
    }
    if (page && !page.items.length) {
      if (reason === 'older') s.older = false
      if (reason === 'newer') s.newer = false
    } else if (page?.items.length) {
      const first = page.items[0], last = page.items.at(-1)
      if (!old.length || replacing || compare(first, old[0]) <= 0) s.older = page.has_older
      if (!old.length || replacing || compare(last, old.at(-1)) >= 0) s.newer = page.has_newer
      s.ranges.push({ start: key(first), end: key(last) })
      // A page adjacent to its requested boundary covers that boundary too.
      if (s.pageBoundary) s.ranges.push({ start: key(compare(first, s.pageBoundary) < 0 ? first : s.pageBoundary), end: key(compare(last, s.pageBoundary) > 0 ? last : s.pageBoundary) })
    } else if (reason === 'sync' && incoming.length && !old.length) {
      const ordered = incoming.slice().sort(compare)
      s.ranges.push({ start: key(ordered[0]), end: key(ordered.at(-1)) })
    } else if (reason === 'sync' && incoming.length && old.length && !s.newer) {
      // Replay returns every intervening create, including across batches.
      s.ranges.push({ start: key(old.at(-1)), end: key(incoming.slice().sort(compare).at(-1)) })
    }
    const all = [...map.values()].sort(compare)
    if (merged.length && all.length) {
      if (compare(merged[0], all[0]) > 0) s.older = true
      if (compare(merged.at(-1), all.at(-1)) < 0) s.newer = true
      s.ranges = s.ranges.filter(range => compare(range.end, merged[0]) >= 0 && compare(range.start, merged.at(-1)) <= 0)
        .map(range => ({ start: compare(range.start, merged[0]) < 0 ? key(merged[0]) : range.start,
          end: compare(range.end, merged.at(-1)) > 0 ? key(merged.at(-1)) : range.end }))
        .sort((a, b) => compare(a.start, b.start))
      const joined = []
      for (const range of s.ranges) {
        const previous = joined.at(-1)
        if (previous && compare(range.start, previous.end) <= 0) {
          if (compare(range.end, previous.end) > 0) previous.end = range.end
        } else joined.push({ ...range })
      }
      s.ranges = joined
    }
    s.messages = merged
    setMessages(merged)
    setRanges(s.ranges)
    setHasOlder(s.older)
    setHasNewer(s.newer)
    if (targetId) setNavigationId(targetId)
  }, [beforeChange, atBottom])

  useEffect(() => {
    const s = { active: true, messages: [], ranges: [], older: false, newer: false,
      controller: new AbortController(), readController: null, readBoundary: null, readDone: null,
      cursor: null, id: null, running: false, dirty: false, queue: [], readBusy: false }
    session.current = s
    setStage('opening'); setError(''); setSyncError(''); setMessages([]); setConversation(null)
    setNewCount(0); setHasOlder(false); setHasNewer(false); setRanges([]); setNavigationId(null)
    atBottom.current = true

    function metadata(data) {
      s.readBoundary = data.read_cursor
      s.readThroughId = data.read_through_id
    }

    async function acknowledgeRange() {
      if (!s.active || !s.readBoundary || s.readBusy) return
      const read = document.visibilityState === 'visible' && viewVisible.current
      const identity = `${s.readThroughId}:${read}`
      if (s.readDone === identity) return
      s.readBusy = true
      const controller = new AbortController()
      s.readController = controller
      try {
        const result = await markConversationRead(token, s.id, s.readBoundary, controller.signal, read)
        if (!s.active) return
        s.readDone = identity
        if (result.changed) { onPersistedRead(); wake() }
      } catch (error) {
        if (s.active && error.status === 401) onUnauthorized()
        // The periodic recovery and visibility transition retry failed ranges.
      } finally {
        s.readBusy = false
      }
    }

    async function latest(reason = 'latest') {
      const page = await getMessagePage(token, s.id, s.controller.signal)
      if (!s.active) return
      install(s, page.items, [], reason, page)
      metadata(page)
      if (!s.cursor || reason === 'reset') s.cursor = page.sync_cursor
      if (reason === 'latest' || reason === 'reset') { setNewCount(0); atBottom.current = true }
    }

    async function recover() {
      if (!s.cursor) return
      let more = true
      while (s.active && more) {
        let data
        try {
          const ids = [...new Set([...s.messages.map(message => message.id), ...tracked.current])]
          data = await synchronize(token, s.id, s.cursor, ids, s.controller.signal)
        } catch (error) {
          if ([409, 410].includes(error.status)) {
            // Gaps are explicit: replace the bounded window with a new snapshot.
            setSyncError('Recovering the latest messages...')
            s.messages = []; s.ranges = []
            await latest('reset')
            s.dirty = true
            return
          }
          throw error
        }
        if (!s.active) return
        onReconciled(data.items, data.missing_ids)
        const created = data.events.filter(event => event.kind === 'new').length
        if (created && !atBottom.current) setNewCount(count => count + created)
        const relevant = new Set([...s.messages.map(message => message.id), ...data.events.filter(event => event.kind === 'new').map(event => event.message_id)])
        install(s, data.items.filter(message => relevant.has(message.id)), data.missing_ids)
        metadata(data)
        if (!data.read_through_id || s.messages.at(-1)?.id === data.read_through_id) {
          s.newer = false
          setHasNewer(false)
        }
        // Advance only after installing the response. Concurrent socket hints
        // never advance the stream; duplicate/replayed invalidations are safe.
        s.cursor = data.next_cursor
        more = data.has_more
        if (!more && !s.messages.length && data.read_through_id) await latest('reset')
      }
    }

    async function run() {
      if (!s.active || s.running || !s.id || !s.cursor) return
      s.running = true
      setBusy(true)
      try {
        while (s.active && (s.dirty || s.queue.length)) {
          // Recovery takes priority so held history responses cannot overwrite
          // newer state. All timeline HTTP requests share one serial worker.
          if (s.dirty) { s.dirty = false; await recover() }
          else {
            const job = s.queue.shift()
            if (job.kind === 'latest') await latest()
            else {
              s.pageBoundary = job.boundary
              const page = job.kind === 'context'
                ? await getMessageContext(token, s.id, job.id, s.controller.signal)
                : await getMessagePage(token, s.id, s.controller.signal, { [job.kind === 'older' ? 'before' : 'after']: job.boundary._cursor })
              if (!s.active) return
              install(s, page.items, [], job.kind, page, job.kind === 'context' ? job.id : null)
              s.pageBoundary = null
              metadata(page)
            }
            s.dirty = true
          }
        }
        if (s.active) { setSyncError(''); await acknowledgeRange() }
      } catch (error) {
        if (!s.active || error.name === 'AbortError') return
        s.pageBoundary = null
        if (error.status === 401) onUnauthorized()
        else setSyncError(error.status === 404 ? 'That message is no longer available.' : 'Unable to update messages. Retry to recover.')
      } finally {
        s.running = false
        if (s.active) { setBusy(false); if (s.dirty || s.queue.length) s.timer = setTimeout(run, 100) }
      }
    }

    function wake(id) {
      if (id && id !== s.id) return
      s.dirty = true
      clearTimeout(s.timer)
      s.timer = setTimeout(run, 80)
    }
    s.wake = wake
    s.request = job => { s.queue.push(job); wake() }
    const unsubscribe = subscribeToSync(wake)
    const visibility = () => { if (document.visibilityState === 'visible') wake() }
    document.addEventListener('visibilitychange', visibility)
    // HTTP recovery also covers a dropped frame on an apparently healthy socket.
    const poll = setInterval(() => { if (document.visibilityState === 'visible') wake() }, 15000)

    async function open() {
      try {
        const resolved = initialConversation || await getOrCreateConversation(token, selectedUser.id, s.controller.signal)
        if (!s.active) return
        s.id = resolved.id
        setConversation(resolved)
        onConversationOpened(resolved)
        setStage('loading')
        await latest('initial')
        await recover()
        if (!s.active) return
        setStage('ready')
        await acknowledgeRange()
        if (s.dirty) wake()
      } catch (error) {
        if (!s.active || error.name === 'AbortError') return
        if (error.status === 401) onUnauthorized()
        else { setError('Unable to load this conversation. Please try again.'); setStage('error') }
      }
    }
    // Keep wakeups queued until both the HTTP snapshot and initial replay finish.
    s.running = true
    open().finally(() => { s.running = false; if (s.active && s.dirty) wake() })
    return () => {
      s.active = false
      s.controller.abort(); s.readController?.abort()
      clearTimeout(s.timer); clearInterval(poll)
      unsubscribe(); document.removeEventListener('visibilitychange', visibility)
    }
  }, [token, selectedUser.id, initialConversation, retryAttempt, onUnauthorized, onConversationOpened,
    subscribeToSync, install, atBottom, onPersistedRead, onReconciled])

  const load = kind => {
    const s = session.current
    if (!s?.active || busy) return
    const boundary = kind === 'older' ? s.messages[0] : s.messages.at(-1)
    if (boundary?._cursor) s.request({ kind, boundary })
  }
  const navigate = id => {
    const s = session.current
    if (!s?.active) return
    if (s.messages.some(message => message.id === id)) { beforeChange('context'); setNavigationId(null); requestAnimationFrame(() => { if (s.active) setNavigationId(id) }) }
    else s.request({ kind: 'context', id })
  }
  const jumpLatest = () => { const s = session.current; if (s?.active) s.request({ kind: 'latest' }) }
  const addLocal = message => {
    const s = session.current
    if (!s?.active || s.id !== message.conversation_id) return
    // Local creates are useful immediately; all fields are then reconciled.
    install(s, [message], [], 'local')
    s.wake()
  }
  const isGap = (a, b) => !ranges.some(range => compare(range.start, a) <= 0 && compare(range.end, b) >= 0)
  return { messages, conversation, stage, loadError: error, busy, syncError, hasOlder, hasNewer, newCount,
    navigationId, loadOlder: () => load('older'), loadNewer: () => load('newer'), jumpLatest, navigate,
    loadGap: boundary => session.current?.request({ kind: 'newer', boundary }), isGap,
    retrySync: () => session.current?.wake(), addMessages: incoming => incoming.forEach(addLocal),
    clearNavigation: () => setNavigationId(null), clearNew: () => setNewCount(0) }
}
