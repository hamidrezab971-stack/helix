import { useCallback, useEffect, useRef, useReducer } from 'react'
import { getPresence } from '../services/api.js'
import { initialPresence, presenceReducer } from '../utils/presenceState.js'
export default function usePresence(token, onUnauthorized) {
  const [state, dispatch] = useReducer(presenceReducer, undefined, initialPresence)
  const controller = useRef(null)
  const refresh = useCallback(async () => {
    controller.current?.abort()
    const request = new AbortController(); controller.current = request
    try {
      const result = await getPresence(token, request.signal)
      if (request.signal.aborted) return
      dispatch({ type: 'details', users: result.users, server_time: result.server_time, now: Date.now() })
    } catch (error) { if (!request.signal.aborted && error.status === 401) onUnauthorized() }
  }, [token, onUnauthorized])
  useEffect(() => {
    const tick = () => dispatch({ type: 'clock', now: Date.now() })
    const visible = () => { if (document.visibilityState === 'visible') { tick(); refresh() } }
    const timer = setInterval(() => { if (document.visibilityState === 'visible') tick() }, 30000)
    document.addEventListener('visibilitychange', visible)
    refresh()
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', visible); controller.current?.abort() }
  }, [refresh])
  const snapshot = useCallback((ids, metadata = {}) => {
    dispatch({ type: 'snapshot', ids, ...metadata, now: Date.now() })
    refresh()
  }, [refresh])
  const update = useCallback(data => {
    // Advance the reference clock in the SAME render as a new timestamp.
    dispatch({ ...data, type: 'update', now: Date.now() })
  }, [])
  const disconnect = useCallback(() => {
    controller.current?.abort()
    dispatch({ type: 'disconnect', now: Date.now() })
  }, [])
  return { onlineIds: state.onlineIds, lastSeen: state.lastSeen, now: state.now, refresh, snapshot, update, disconnect }
}
