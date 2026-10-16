import { API_URL, safeMessage, safeReceipt } from './api.js'

function websocketUrl() {
  if (import.meta.env.VITE_WS_URL) return import.meta.env.VITE_WS_URL
  const url = new URL(`${API_URL}/ws`, window.location.origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

export function connectRealtime(token, { onMessage, onMutation, onReactions, onStatus, onUnauthorized, onPresenceSnapshot, onPresenceUpdate, onTyping, onDisconnect, onWake }) {
  let socket
  let timer
  let stopped = false
  let attempt = 0
  let stableTimer
  let heartbeat
  let authTimer
  let authenticated = false
  const acknowledgements = new Map()
  const sentAcknowledgements = new Map()

  function forgetMessage(messageId) {
    acknowledgements.delete(messageId)
    sentAcknowledgements.delete(messageId)
  }

  function flushAcknowledgements() {
    if (stopped || !authenticated || socket?.readyState !== WebSocket.OPEN) return
    for (const [messageId, type] of acknowledgements) {
      if (sentAcknowledgements.get(messageId) === type) continue
      try {
        socket.send(JSON.stringify({ type, message_id: messageId }))
        sentAcknowledgements.set(messageId, type)
      } catch { return }
    }
  }

  function acknowledge(type, messageId) {
    if (stopped || !['message:delivered', 'message:read'].includes(type) || !Number.isSafeInteger(messageId) || messageId <= 0) return
    if (acknowledgements.size >= 1024) forgetMessage(acknowledgements.keys().next().value)
    if (acknowledgements.get(messageId) !== 'message:read') acknowledgements.set(messageId, type)
    flushAcknowledgements()
  }

  function sendTyping(type, conversationId) {
    if (stopped || !authenticated || socket?.readyState !== WebSocket.OPEN) return false
    if (!['typing:start', 'typing:stop'].includes(type) || !Number.isSafeInteger(conversationId) || conversationId <= 0) return false
    try {
      socket.send(JSON.stringify({ type, conversation_id: conversationId }))
      return true
    } catch {
      return false
    }
  }

  function stop() {
    stopped = true
    clearTimeout(timer)
    clearTimeout(stableTimer)
    clearTimeout(authTimer)
    clearInterval(heartbeat)
    window.removeEventListener('online', online)
    if (socket) socket.close(1000)
  }

  function unauthorized() {
    if (stopped) return
    stop()
    onUnauthorized()
  }

  function reconnect() {
    if (!stopped) {
      clearTimeout(timer)
      const ceiling = Math.min(30000, 1000 * 2 ** Math.min(attempt++, 5))
      timer = setTimeout(open, ceiling * (0.5 + Math.random() * 0.5))
    }
  }

  function open() {
    if (stopped) return
    authenticated = false
    sentAcknowledgements.clear()
    try {
      socket = new WebSocket(websocketUrl())
    } catch {
      reconnect()
      return
    }
    const current = socket
    authTimer = setTimeout(() => current.close(), 10000)
    current.onopen = () => {
      if (stopped) return current.close(1000)
      current.send(JSON.stringify({ type: 'auth', token, presence_version: 18 }))
    }
    current.onmessage = (event) => {
      if (stopped || current !== socket) return
      let payload
      try {
        payload = JSON.parse(event.data)
      } catch {
        return
      }
      if (payload?.type === 'auth:error') return unauthorized()
      if (payload?.type === 'auth:ok') {
        authenticated = true
        clearInterval(heartbeat)
        heartbeat = setInterval(() => { if (current.readyState === WebSocket.OPEN) current.send(JSON.stringify({ type: 'presence:heartbeat' })) }, 30000)
        clearTimeout(authTimer)
        stableTimer = setTimeout(() => { attempt = 0 }, 10000)
        onWake?.()
        flushAcknowledgements()
        return
      }
      if (!authenticated) return
      const data = payload?.data
      if (payload.type?.startsWith('message:') || payload.type === 'conversation:receipts') onWake?.(data?.conversation_id)
      const validId = (id) => Number.isSafeInteger(id) && id > 0
      if (payload?.type === 'message:reactions' && validId(data?.message_id) && validId(data?.conversation_id)) {
        onReactions({ message_id: data.message_id, conversation_id: data.conversation_id })
      }
      if (payload?.type === 'message:updated') {
        let message
        try { message = safeMessage(data) } catch { return }
        if (!message.edited_at) return
        onMutation({ type: payload.type, data: message })
      } else if (payload?.type === 'message:deleted' && validId(data?.message_id) && validId(data?.conversation_id)) {
        forgetMessage(data.message_id)
        onMutation({ type: payload.type, data: { message_id: data.message_id, conversation_id: data.conversation_id } })
      }
      if (payload?.type === 'message:status' && validId(data?.message_id)) {
        let receipt
        try { receipt = safeReceipt(data) } catch { return }
        const pending = acknowledgements.get(data.message_id)
        if (receipt.read_at || (receipt.delivered_at && pending !== 'message:read')) forgetMessage(data.message_id)
        onStatus({ message_id: data.message_id, ...receipt })
      }
      if (payload?.type === 'presence:snapshot' && Array.isArray(data?.online_user_ids) && data.online_user_ids.every(validId)) {
        onPresenceSnapshot(data.online_user_ids)
      } else if (payload?.type === 'presence:update' && validId(data?.user_id) && ['online', 'offline'].includes(data?.status)) {
        onPresenceUpdate({ user_id: data.user_id, status: data.status, last_seen_at: typeof data.last_seen_at === 'string' && Number.isFinite(Date.parse(data.last_seen_at)) ? data.last_seen_at : null })
      } else if (['typing:start', 'typing:stop'].includes(payload?.type) && validId(data?.conversation_id) && validId(data?.user_id)) {
        onTyping({ type: payload.type, data: { conversation_id: data.conversation_id, user_id: data.user_id } })
      }
      if (authenticated && payload?.type === 'message:new') {
        let message
        try {
          message = safeMessage(payload.data)
        } catch {
          return
        }
        onMessage(message)
      }
    }
    current.onerror = () => {} // The close handler schedules recovery.
    current.onclose = (event) => {
      if (stopped || current !== socket) return
      authenticated = false
      clearTimeout(authTimer)
      clearTimeout(stableTimer)
      clearInterval(heartbeat)
      onDisconnect()
      if (event.code === 4401) return unauthorized()
      reconnect()
    }
  }

  function online() {
    if (!stopped && (!socket || socket.readyState === WebSocket.CLOSED)) { clearTimeout(timer); open() }
  }
  window.addEventListener('online', online)

  // Deferring startup also avoids a throwaway connection in React StrictMode.
  timer = setTimeout(open, 0)
  return { stop, sendTyping, acknowledge, forgetMessage }
}
