import { useCallback, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { sendMessage, sendImage } from '../services/api.js'
import { reconcilePending } from '../utils/optimisticMessages.js'

// Owned by HomePage, so changing conversations does not destroy a timed-out
// send's immutable intent, file, UUID, or in-flight request. Logout releases all.
export default function useOptimisticMessages({ token, userId, onUnauthorized, onChanged, subscribeToMessages }) {
  const [entries, setEntries] = useState([])
  const store = useRef([]), requests = useRef(new Map()), active = useRef(true)
  const publish = useCallback(next => { store.current = next; if (active.current) setEntries(next) }, [])
  const update = useCallback((id, patch) => publish(store.current.map(entry => entry.localId === id ? { ...entry, ...patch } : entry)), [publish])
  const reconcile = useCallback((messages, missing = []) => {
    const next = reconcilePending(store.current, messages, missing)
    if (next.length !== store.current.length) publish(next)
  }, [publish])
  useEffect(() => {
    active.current = true
    return () => { active.current = false; for (const controller of requests.current.values()) controller.abort() }
  }, [token])
  useEffect(() => subscribeToMessages(message => {
    if (message.sender_id !== userId || !message.client_message_id) return
    update(message.client_message_id, { serverId: message.id, state: 'sent', error: '' })
  }), [subscribeToMessages, userId, update])

  const transmit = useCallback(async entry => {
    if (requests.current.has(entry.localId)) return
    const controller = new AbortController()
    requests.current.set(entry.localId, controller)
    update(entry.localId, { state: 'sending', error: '' })
    const timeout = setTimeout(() => controller.abort(), 30000)
    try {
      const message = entry.file
        ? await sendImage(token, entry.conversation_id, entry.file, entry.content, controller.signal, entry.reply_to?.id || null, entry.client_message_id)
        : await sendMessage(token, entry.conversation_id, entry.content, controller.signal, entry.reply_to?.id || null, entry.client_message_id)
      if (!active.current) return
      // A late REST response is only a confirmation; Phase 17 recovery owns
      // canonical fields, including a newer edit or deletion received meanwhile.
      update(entry.localId, { serverId: message.id, state: 'sent', error: '' })
      onChanged()
    } catch (error) {
      if (!active.current) return
      if (error.status === 401) onUnauthorized()
      else {
        const current = store.current.find(item => item.localId === entry.localId)
        if (current?.state !== 'sent') update(entry.localId, { state: 'failed', terminal: [409, 410].includes(error.status), error: error.status === 410 ? 'This message was already sent and deleted.' : controller.signal.aborted ? 'Send timed out. Retry safely.' : error.displayMessage || 'Unable to send. Please retry.' })
      }
    } finally { clearTimeout(timeout); requests.current.delete(entry.localId) }
  }, [token, update, onChanged, onUnauthorized])
  const enqueue = useCallback(intent => {
    if (store.current.length >= 20) throw new Error('Retry or dismiss pending messages before sending more.')
    const id = crypto.randomUUID()
    const entry = { ...intent, sender_id: userId, localId: id, client_message_id: id, state: 'queued', enteredAt: performance.now() }
    flushSync(() => publish([...store.current, entry]))
    // Publish the queued bubble before starting transport work.
    queueMicrotask(() => { if (active.current) transmit(entry) })
    return id
  }, [publish, transmit, userId])
  return { entries, enqueue, reconcile, retry: id => { const entry = store.current.find(item => item.localId === id); if (entry?.state === 'failed' && !entry.terminal) transmit(entry) }, dismiss: id => { if (!requests.current.has(id)) publish(store.current.filter(entry => entry.localId !== id)) } }
}
