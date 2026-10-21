import { useCallback, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { sendMessage, sendImage } from '../services/api.js'
import { reconcilePending } from '../utils/optimisticMessages.js'
import { MAX_PENDING_IMAGE_BYTES } from '../utils/chatImage.js'

// Owned by HomePage, so changing conversations does not destroy a timed-out
// send's immutable intent, file, UUID, or in-flight request. Logout releases all.
export default function useOptimisticMessages({ token, userId, onUnauthorized, onChanged, subscribeToMessages }) {
  const [entries, setEntries] = useState([])
  const store = useRef([]), requests = useRef(new Map()), active = useRef(true), generation = useRef(0)
  const publish = useCallback(next => { store.current = next; if (active.current) setEntries(next) }, [])
  const update = useCallback((id, patch) => publish(store.current.map(entry => entry.localId === id ? { ...entry, ...patch } : entry)), [publish])
  const reconcile = useCallback((messages, missing = []) => {
    const next = reconcilePending(store.current, messages, missing)
    if (next.length !== store.current.length) publish(next)
  }, [publish])
  useEffect(() => {
    active.current = true
    if (!store.current.length) setEntries([])
    return () => { active.current = false; generation.current++; for (const controller of requests.current.values()) controller.abort(); requests.current.clear(); store.current = [] }
  }, [token])
  useEffect(() => subscribeToMessages(message => {
    if (message.sender_id !== userId || !message.client_message_id) return
    update(message.client_message_id, { serverId: message.id, state: 'sent', error: '' })
  }), [subscribeToMessages, userId, update])

  const transmit = useCallback(async (entry, retry = false) => {
    if (requests.current.has(entry.localId)) return
    const controller = new AbortController()
    const epoch = generation.current
    const currentRequest = () => active.current && generation.current === epoch && requests.current.get(entry.localId) === controller
    requests.current.set(entry.localId, controller)
    update(entry.localId, { state: retry ? 'retrying' : entry.file ? 'uploading' : 'sending', progress: null, error: '' })
    const timeout = setTimeout(() => controller.abort(), entry.file ? 120000 : 30000)
    try {
      const message = entry.file
        ? await sendImage(token, entry.conversation_id, entry.file, entry.content, controller.signal, entry.reply_to?.id || null, entry.client_message_id, {
          filename: entry.filename,
          onProgress: progress => { if (currentRequest()) update(entry.localId, { state: 'uploading', progress }) },
          onUploaded: () => { if (currentRequest()) update(entry.localId, { state: 'sending', progress: null }) },
        })
        : await sendMessage(token, entry.conversation_id, entry.content, controller.signal, entry.reply_to?.id || null, entry.client_message_id)
      if (!currentRequest()) return
      // A late REST response is only a confirmation; Phase 17 recovery owns
      // canonical fields, including a newer edit or deletion received meanwhile.
      update(entry.localId, { serverId: message.id, state: 'sent', error: '' })
      onChanged()
    } catch (error) {
      if (!currentRequest()) return
      const current = store.current.find(item => item.localId === entry.localId)
      if (current?.state !== 'sent') update(entry.localId, { state: 'failed', progress: null, terminal: [400, 403, 404, 409, 410, 413, 415, 422].includes(error.status), error: error.status === 410 ? 'This message was already sent and deleted.' : controller.signal.aborted ? 'Send timed out. Retry safely.' : error.displayMessage || 'Unable to send. Please retry.' })
      if (error.status === 401) onUnauthorized()
    } finally { clearTimeout(timeout); if (requests.current.get(entry.localId) === controller) requests.current.delete(entry.localId) }
  }, [token, update, onChanged, onUnauthorized])
  const enqueue = useCallback(intent => {
    if (store.current.length >= 20) throw new Error('Retry or dismiss pending messages before sending more.')
    if (store.current.reduce((total, entry) => total + (entry.file?.size || 0), 0) + (intent.file?.size || 0) > MAX_PENDING_IMAGE_BYTES) throw new Error('Retry or dismiss pending photos before selecting more (32 MB limit).')
    const id = crypto.randomUUID()
    const entry = { ...intent, sender_id: userId, localId: id, client_message_id: id, state: 'queued', enteredAt: performance.now() }
    flushSync(() => publish([...store.current, entry]))
    // Publish the queued bubble before starting transport work.
    queueMicrotask(() => { if (active.current) transmit(entry) })
    return id
  }, [publish, transmit, userId])
  return { entries, enqueue, reconcile, retry: id => { const entry = store.current.find(item => item.localId === id); if (entry?.state === 'failed' && !entry.terminal) transmit(entry, true) }, cancel: id => {
    const controller = requests.current.get(id)
    if (controller) { requests.current.delete(id); controller.abort() }
    update(id, { state: 'cancelled', file: null, progress: null, error: '' })
  }, dismiss: id => {
    const controller = requests.current.get(id)
    if (controller) { requests.current.delete(id); controller.abort() }
    publish(store.current.filter(entry => entry.localId !== id))
  } }
}
