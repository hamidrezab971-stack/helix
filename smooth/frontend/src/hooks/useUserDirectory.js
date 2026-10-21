import { useEffect, useRef, useState } from 'react'
import { getUsers } from '../services/api.js'
import { useIdentity } from '../components/profile/IdentityProvider.jsx'

export default function useUserDirectory({ token, userId, enabled, query, onUnauthorized }) {
  const updateIdentity = useIdentity()?.update
  const key = query.trim().toLowerCase()
  const cache = useRef(new Map())
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState({ key: null, users: [], error: '', pending: false, loading: false })

  useEffect(() => { cache.current.clear() }, [token])
  useEffect(() => {
    if (!enabled) return
    const cached = cache.current.get(key)
    if (cached && Date.now() - cached.at < 30000) {
      setResult({ key, users: cached.users, error: '', pending: false, loading: false })
      return
    }
    const controller = new AbortController()
    let loadingTimer
    setResult({ key, users: [], error: '', pending: true, loading: false })
    const debounce = setTimeout(async () => {
      loadingTimer = setTimeout(() => {
        if (!controller.signal.aborted) setResult(current => ({ ...current, loading: true }))
      }, 140)
      try {
        const users = (await getUsers(token, key, controller.signal)).filter(person => person.id !== userId)
        if (controller.signal.aborted) return
        for (const user of users) updateIdentity?.(user)
        cache.current.set(key, { at: Date.now(), users })
        // Bound retained query results even during a long session.
        if (cache.current.size > 30) cache.current.delete(cache.current.keys().next().value)
        setResult({ key, users, error: '', pending: false, loading: false })
      } catch (error) {
        if (controller.signal.aborted || error.name === 'AbortError') return
        if (error.status === 401) onUnauthorized()
        else setResult({ key, users: [], error: 'Unable to load people.', pending: false, loading: false })
      } finally { clearTimeout(loadingTimer) }
    }, key ? 260 : 0)
    return () => { controller.abort(); clearTimeout(debounce); clearTimeout(loadingTimer) }
  }, [token, userId, enabled, key, attempt, onUnauthorized, updateIdentity])

  const current = result.key === key ? result : { users: [], error: '', pending: true, loading: false }
  return { ...current, retry: () => { cache.current.delete(key); setAttempt(value => value + 1) } }
}
