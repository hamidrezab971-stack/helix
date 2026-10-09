export const API_URL = (import.meta.env.VITE_API_URL || 'http://127.0.0.1:8000').replace(/\/+$/, '')
const GENERIC_ERROR = 'Something went wrong. Please try again.'

function apiError(message, status) {
  const error = new Error(message)
  error.displayMessage = message
  error.status = status
  return error
}

async function request(path, { body, token, signal, method } = {}) {
  const headers = {}
  if (body) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = `Bearer ${token}`

  let response
  try {
    response = await fetch(`${API_URL}${path}`, {
      method: method || (body ? 'POST' : 'GET'),
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal,
    })
  } catch (error) {
    if (error.name === 'AbortError') throw error
    throw apiError('Unable to connect to the server.')
  }

  let data
  try {
    data = await response.json()
  } catch {
    throw apiError(GENERIC_ERROR, response.status)
  }

  if (!response.ok) {
    let message = GENERIC_ERROR
    if (response.status === 401) {
      message = path.endsWith('/login')
        ? 'Invalid username or password'
        : 'Your sign-in has expired. Please log in again.'
    } else if (path.startsWith('/api/conversations') && [403, 404].includes(response.status)) {
      message = path.includes('/with/')
        ? 'This user is no longer available.'
        : 'This conversation is unavailable or you don’t have access to it.'
    } else if (path.startsWith('/api/conversations') && response.status === 400) {
      message = 'Choose another user to start a conversation.'
    } else if (response.status === 409) {
      message = 'Username already exists'
    } else if (response.status === 422) {
      const errors = Array.isArray(data.detail) ? data.detail : []
      if (errors.some((error) => error.loc?.includes('content'))) {
        message = 'Use a message between 1 and 2000 characters.'
      } else if (errors.some((error) => error.loc?.includes('username'))) {
        message = 'Use 3–30 letters, numbers, or underscores for your username.'
      } else if (errors.some((error) => error.loc?.includes('password'))) {
        message = 'Use a password between 8 and 128 characters.'
      } else {
        message = 'Please check your username and password.'
      }
    }
    throw apiError(message, response.status)
  }
  return data
}

function safeUser(data) {
  if (!Number.isInteger(data?.id) || typeof data.username !== 'string' || typeof data.created_at !== 'string') {
    throw apiError(GENERIC_ERROR)
  }
  return { id: data.id, username: data.username, created_at: data.created_at }
}

export async function register(username, password) {
  return safeUser(await request('/api/auth/register', { body: { username, password } }))
}

export async function login(username, password) {
  const data = await request('/api/auth/login', { body: { username, password } })
  if (typeof data?.access_token !== 'string' || !data.access_token || data.token_type !== 'bearer') {
    throw apiError(GENERIC_ERROR)
  }
  return data
}

export async function getCurrentUser(token, signal) {
  return safeUser(await request('/api/auth/me', { token, signal }))
}

export async function getUsers(token, search = '', signal) {
  const query = new URLSearchParams({ search: search.trim().toLowerCase() })
  const data = await request(`/api/users?${query}`, { token, signal })
  if (!Array.isArray(data)) throw apiError(GENERIC_ERROR)
  return data.map(safeUser)
}

export function safeMessage(data) {
  if (![data?.id, data?.conversation_id, data?.sender_id].every((id) => Number.isSafeInteger(id) && id > 0) || typeof data.content !== 'string' || !data.content.trim() || Array.from(data.content).length > 2000 || typeof data.created_at !== 'string' || !Number.isFinite(Date.parse(data.created_at))) {
    throw apiError(GENERIC_ERROR)
  }
  return { id: data.id, conversation_id: data.conversation_id, sender_id: data.sender_id, content: data.content, created_at: data.created_at, ...safeReceipt(data) }
}

export function safeReceipt(data) {
  const delivered_at = data?.delivered_at ?? null
  const read_at = data?.read_at ?? null
  if (![delivered_at, read_at].every((value) => value === null || (typeof value === 'string' && Number.isFinite(Date.parse(value)))) || (read_at && !delivered_at)) throw apiError(GENERIC_ERROR)
  return { delivered_at, read_at }
}

export function mergeReceipt(current, incoming) {
  return { delivered_at: current?.delivered_at || incoming?.delivered_at || null, read_at: current?.read_at || incoming?.read_at || null }
}

export async function getOrCreateConversation(token, userId, signal) {
  const data = await request(`/api/conversations/with/${userId}`, { token, signal, method: 'POST' })
  if (!Number.isInteger(data?.id) || typeof data.created_at !== 'string') throw apiError(GENERIC_ERROR)
  return { id: data.id, created_at: data.created_at, other_user: safeUser(data.other_user) }
}

export async function getMessages(token, conversationId, signal) {
  const data = await request(`/api/conversations/${conversationId}/messages`, { token, signal })
  if (!Array.isArray(data)) throw apiError(GENERIC_ERROR)
  return data.map(safeMessage)
}

export async function sendMessage(token, conversationId, content, signal) {
  return safeMessage(await request(`/api/conversations/${conversationId}/messages`, { token, signal, body: { content } }))
}
