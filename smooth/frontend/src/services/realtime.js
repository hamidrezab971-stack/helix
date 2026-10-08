import { API_URL, safeMessage } from './api.js'

function websocketUrl() {
  if (import.meta.env.VITE_WS_URL) return import.meta.env.VITE_WS_URL
  const url = new URL(`${API_URL}/ws`)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

export function connectRealtime(token, { onMessage, onUnauthorized }) {
  let socket
  let timer
  let stopped = false

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
    let authenticated = false
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
      if (event.code === 4401) return unauthorized()
      reconnect()
    }
  }

  // Deferring startup also avoids a throwaway connection in React StrictMode.
  timer = setTimeout(open, 0)
  return stop
}
