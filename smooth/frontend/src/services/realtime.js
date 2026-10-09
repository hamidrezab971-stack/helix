import { API_URL, safeMessage } from './api.js'

function websocketUrl() {
  if (import.meta.env.VITE_WS_URL) return import.meta.env.VITE_WS_URL
  const url = new URL(`${API_URL}/ws`)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

export function connectRealtime(token, { onMessage, onUnauthorized, onPresenceSnapshot, onPresenceUpdate, onTyping, onDisconnect }) {
  let socket
  let timer
  let stopped = false
  let authenticated = false

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
    if (socket) socket.close(1000)
  }

  function unauthorized() {
    if (stopped) return
    stop()
    onUnauthorized()
  }

  function reconnect() {
    if (!stopped) timer = setTimeout(open, 2000)
  }

  function open() {
    if (stopped) return
    authenticated = false
    try {
      socket = new WebSocket(websocketUrl())
    } catch {
      reconnect()
      return
    }
    const current = socket
    current.onopen = () => {
      if (stopped) return current.close(1000)
      current.send(JSON.stringify({ type: 'auth', token }))
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
        return
      }
      if (!authenticated) return
      const data = payload?.data
      const validId = (id) => Number.isSafeInteger(id) && id > 0
      if (payload?.type === 'presence:snapshot' && Array.isArray(data?.online_user_ids) && data.online_user_ids.every(validId)) {
        onPresenceSnapshot(data.online_user_ids)
      } else if (payload?.type === 'presence:update' && validId(data?.user_id) && ['online', 'offline'].includes(data?.status)) {
        onPresenceUpdate({ user_id: data.user_id, status: data.status })
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
      onDisconnect()
      if (event.code === 4401) return unauthorized()
      reconnect()
    }
  }

  // Deferring startup also avoids a throwaway connection in React StrictMode.
  timer = setTimeout(open, 0)
  return { stop, sendTyping }
}
