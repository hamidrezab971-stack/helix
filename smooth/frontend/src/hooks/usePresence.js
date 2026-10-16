import { useCallback, useEffect, useRef, useState } from 'react'
import { getPresence } from '../services/api.js'
export default function usePresence(token, onUnauthorized) {
  const [onlineIds, setOnlineIds] = useState(new Set())
  const [lastSeen, setLastSeen] = useState(new Map())
  const [now, setNow] = useState(Date.now())
  const offset = useRef(0), controller = useRef(null)
  const refresh = useCallback(async () => {
    controller.current?.abort()
    const request = new AbortController(); controller.current = request
    try {
      const result = await getPresence(token, request.signal)
      if (request.signal.aborted) return
      offset.current = Date.parse(result.server_time) - Date.now()
      setNow(Date.now() + offset.current)
      setLastSeen(previous => {
        const next = new Map(previous)
        for (const peer of result.users) if (peer.last_seen_at && (!next.get(peer.user_id) || Date.parse(peer.last_seen_at) > Date.parse(next.get(peer.user_id)))) next.set(peer.user_id, peer.last_seen_at)
        return next
      })
    } catch (error) { if (!request.signal.aborted && error.status === 401) onUnauthorized() }
  }, [token, onUnauthorized])
  useEffect(() => {
    const tick = () => setNow(Date.now() + offset.current)
    const visible = () => { if (document.visibilityState === 'visible') { tick(); refresh() } }
    const timer = setInterval(() => { if (document.visibilityState === 'visible') tick() }, 30000)
    document.addEventListener('visibilitychange', visible)
    refresh()
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', visible); controller.current?.abort() }
  }, [refresh])
  const snapshot = useCallback(ids => { setOnlineIds(new Set(ids)); refresh() }, [refresh])
  const update = useCallback(({ user_id, status, last_seen_at }) => {
    setOnlineIds(previous => { const next = new Set(previous); if (status === 'online') next.add(user_id); else next.delete(user_id); return next })
    if (last_seen_at) setLastSeen(previous => new Map(previous).set(user_id, last_seen_at))
  }, [])
  const disconnect = useCallback(() => setOnlineIds(new Set()), [])
  return { onlineIds, lastSeen, now, refresh, snapshot, update, disconnect }
}
