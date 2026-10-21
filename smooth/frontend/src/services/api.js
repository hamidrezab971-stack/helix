import { uploadMultipart } from './upload.js'

export const API_URL = (import.meta.env?.VITE_API_URL || '').replace(/\/+$/, '')
const GENERIC_ERROR = 'Something went wrong. Please try again.'

function apiError(message, status) {
  const error = new Error(message)
  error.displayMessage = message
  error.status = status
  return error
}

export async function request(path, { body, token, signal, method, binary = false, upload } = {}) {
  const headers = {}
  const multipart = body instanceof FormData
  if (body && !multipart) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = `Bearer ${token}`

  let response
  try {
    response = upload && typeof XMLHttpRequest !== 'undefined'
      ? await uploadMultipart(`${API_URL}${path}`, { body, headers, signal, ...upload })
      : await fetch(`${API_URL}${path}`, {
      method: method || (body ? 'POST' : 'GET'),
      headers,
      body: body ? (multipart ? body : JSON.stringify(body)) : undefined,
      signal,
    })
  } catch (error) {
    if (error.name === 'AbortError') throw error
    if (error.name === 'NotReadableError') throw apiError('This photo could not be read. Please select it again from Gallery or Files.')
    if (globalThis.navigator?.onLine === false) throw apiError('You are offline. Reconnect, then retry your message.')
    if (path.endsWith('/messages/image')) throw apiError('The image upload was interrupted. Check your connection and retry.')
    throw apiError('Unable to connect to the server.')
  }

  let data
  if (response.ok && binary) return response.blob()
  if (response.ok && response.status === 204) return null
  try {
    data = await response.json()
  } catch {
    if (response.ok) throw apiError(GENERIC_ERROR, response.status)
    data = null // Nginx and intermediaries may return HTML for e.g. 413/502.
  }

  if (!response.ok) {
    let message = GENERIC_ERROR
    if (response.status === 401) {
      message = path.endsWith('/login')
        ? 'Invalid username or password'
        : 'Your sign-in has expired. Please log in again.'
    } else if (response.status === 429) {
      message = `Please wait ${response.headers.get('Retry-After') || 'a few'} seconds before trying again.`
    } else if (path.endsWith('/messages/image') && [400, 413, 415, 422, 500, 502, 503, 504].includes(response.status)) {
      message = response.status === 413 ? 'Choose an image of 8 MB or smaller.'
        : [400, 415, 422].includes(response.status) ? 'Choose a valid JPEG, PNG or WebP image (non-animated, up to 25 megapixels) with a caption up to 2000 characters.'
          : 'The server could not save your photo. Your selection is kept; please retry.'
    } else if (path.startsWith('/api/auth/') && [400, 503].includes(response.status)) {
      message = response.status === 400 ? 'Verification expired or invalid. Please verify again.' : 'Verification is busy. Please try again shortly.'
    } else if (path.startsWith('/api/profiles')) {
      message = response.status === 413 ? 'Choose a photo of 2 MB or smaller.' : response.status === 422 ? 'Use a valid JPEG, PNG or WebP, and a biography up to 1000 characters.' : response.status === 409 ? 'Your photo gallery is full.' : 'Unable to update this profile. Please try again.'
    } else if (path.startsWith('/api/messages') && [403, 404].includes(response.status)) {
      message = 'This message is unavailable or you don’t have permission to change it.'
    } else if (path.startsWith('/api/conversations') && [403, 404].includes(response.status)) {
      message = path.includes('/with/')
        ? 'This user is no longer available.'
        : 'This conversation is unavailable or you don’t have access to it.'
    } else if (path.startsWith('/api/conversations') && response.status === 400) {
      message = 'Choose another user to start a conversation.'
    } else if (response.status === 409) {
      message = path.startsWith('/api/conversations') ? 'This send ID belongs to a different message.' : 'Unable to create an account with these details. Try another username or sign in.'
    } else if (response.status === 422) {
      const errors = Array.isArray(data?.detail) ? data.detail : []
      if (path.includes('/reactions')) {
        message = 'Choose a supported reaction.'
      } else if (errors.some((error) => error.loc?.includes('reply_to_message_id'))) {
        message = 'Choose a valid message to reply to.'
      } else if (errors.some((error) => error.loc?.includes('content'))) {
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
  return { id: data.id, username: data.username, created_at: data.created_at, primary_photo_id: Number.isSafeInteger(data.primary_photo_id) ? data.primary_photo_id : null, profile_version: Number.isSafeInteger(data.profile_version) ? data.profile_version : 0 }
}

export async function register(username, password, altcha) {
  return safeUser(await request('/api/auth/register', { body: { username, password, altcha } }))
}

export async function login(username, password, altcha) {
  const data = await request('/api/auth/login', { body: { username, password, altcha } })
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
  const attachment = safeAttachment(data?.attachment)
  if (![data?.id, data?.conversation_id, data?.sender_id].every((id) => Number.isSafeInteger(id) && id > 0) || typeof data.content !== 'string' || (!attachment && !data.content.trim()) || Array.from(data.content).length > 2000 || typeof data.created_at !== 'string' || !Number.isFinite(Date.parse(data.created_at))) {
    throw apiError(GENERIC_ERROR)
  }
  const edited_at = data.edited_at ?? null
  if (edited_at !== null && (typeof edited_at !== 'string' || !Number.isFinite(Date.parse(edited_at)))) throw apiError(GENERIC_ERROR)
  return { id: data.id, client_message_id: typeof data.client_message_id === 'string' ? data.client_message_id : null, conversation_id: data.conversation_id, sender_id: data.sender_id, content: data.content, created_at: data.created_at, edited_at, attachment, reply_to: safeReply(data.reply_to), reactions: safeReactions(data.reactions ?? []), ...safeReceipt(data) }
}

export function safeReactions(data) {
  const order = ['👍', '❤️', '😂', '😮', '😢', '👎']
  if (!Array.isArray(data) || data.length > order.length || new Set(data.map(item => item?.emoji)).size !== data.length) throw apiError(GENERIC_ERROR)
  return data.map(item => {
    if (!order.includes(item?.emoji) || !Number.isSafeInteger(item.count) || item.count <= 0 || typeof item.reacted_by_me !== 'boolean') throw apiError(GENERIC_ERROR)
    return { emoji: item.emoji, count: item.count, reacted_by_me: item.reacted_by_me }
  }).sort((a, b) => order.indexOf(a.emoji) - order.indexOf(b.emoji))
}

function safeReply(data) {
  if (data == null) return null
  if (![data.id, data.sender_id].every(id => Number.isSafeInteger(id) && id > 0) || typeof data.content !== 'string' || Array.from(data.content).length > 200 || ![null, 'image'].includes(data.attachment_kind)) throw apiError(GENERIC_ERROR)
  return { id: data.id, sender_id: data.sender_id, content: data.content, attachment_kind: data.attachment_kind }
}

function safeAttachment(data) {
  if (data == null) return null
  if (data.kind !== 'image' || !['image/jpeg', 'image/png', 'image/webp'].includes(data.mime_type) || ![data.id, data.width, data.height, data.size_bytes].every(value => Number.isSafeInteger(value) && value > 0) || data.size_bytes > 8 * 1024 * 1024) throw apiError(GENERIC_ERROR)
  return { id: data.id, kind: data.kind, mime_type: data.mime_type, size_bytes: data.size_bytes, width: data.width, height: data.height }
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

export async function getConversations(token, signal) {
  const data = await request('/api/conversations', { token, signal })
  if (!Array.isArray(data) || data.length > 50) throw apiError(GENERIC_ERROR)
  return data.map((conversation) => {
    if (!Number.isSafeInteger(conversation?.id) || conversation.id <= 0 || typeof conversation.updated_at !== 'string' || !Number.isFinite(Date.parse(conversation.updated_at)) || !Number.isSafeInteger(conversation.unread_count) || conversation.unread_count < 0) throw apiError(GENERIC_ERROR)
    let last_message = null
    if (conversation.last_message !== null) {
      const message = safeMessage({ ...conversation.last_message, conversation_id: conversation.id })
      last_message = { id: message.id, sender_id: message.sender_id, content: message.content, created_at: message.created_at, attachment: message.attachment }
    }
    return { id: conversation.id, other_user: safeUser(conversation.other_user), last_message, updated_at: conversation.updated_at, unread_count: conversation.unread_count }
  })
}

export async function deleteConversation(token, conversationId, signal) {
  return request(`/api/conversations/${conversationId}`, { token, signal, method: 'DELETE' })
}

export async function getMessages(token, conversationId, signal) {
  const data = await request(`/api/conversations/${conversationId}/messages`, { token, signal })
  if (!Array.isArray(data)) throw apiError(GENERIC_ERROR)
  return data.map(safeMessage)
}

export async function sendMessage(token, conversationId, content, signal, replyToMessageId = null, clientMessageId = null) {
  return safeMessage(await request(`/api/conversations/${conversationId}/messages`, { token, signal, body: { content, reply_to_message_id: replyToMessageId, client_message_id: clientMessageId } }))
}

export async function editMessage(token, messageId, content, signal) {
  return safeMessage(await request(`/api/messages/${messageId}`, { token, signal, method: 'PATCH', body: { content } }))
}

export async function deleteMessage(token, messageId, signal) {
  await request(`/api/messages/${messageId}`, { token, signal, method: 'DELETE' })
}

export async function sendImage(token, conversationId, file, caption, signal, replyToMessageId = null, clientMessageId = null, options = {}) {
  const body = new FormData()
  body.append('file', file, options.filename || file.name || `photo.${file.type === 'image/jpeg' ? 'jpg' : file.type === 'image/webp' ? 'webp' : 'png'}`)
  body.append('caption', caption)
  if (clientMessageId) body.append('client_message_id', clientMessageId)
  if (replyToMessageId !== null) body.append('reply_to_message_id', String(replyToMessageId))
  return safeMessage(await request(`/api/conversations/${conversationId}/messages/image`, { token, signal, body, upload: options }))
}

export async function getAttachmentBlob(token, attachmentId, signal) {
  return request(`/api/attachments/${attachmentId}/content`, { token, signal, binary: true })
}

export async function getReactions(token, messageId, signal) {
  return safeReactions(await request(`/api/messages/${messageId}/reactions`, { token, signal }))
}

export async function changeReaction(token, messageId, emoji, removing, signal) {
  return safeReactions(await request(`/api/messages/${messageId}/reactions${removing ? `/${encodeURIComponent(emoji)}` : ''}`, {
    token, signal, method: removing ? 'DELETE' : 'POST', body: removing ? undefined : { emoji },
  }))
}

function safePage(data) {
  if (!Array.isArray(data?.items) || data.items.length > 100 || !Number.isSafeInteger(data.event_id) || data.event_id < 0 || typeof data.sync_cursor !== 'string' || typeof data.has_older !== 'boolean' || typeof data.has_newer !== 'boolean') throw apiError(GENERIC_ERROR)
  return { ...data, items: data.items.map(item => ({ ...safeMessage(item), _seq: data.event_id, _cursor: data.cursors[item.id] })) }
}

export async function getMessagePage(token, conversationId, signal, direction = {}) {
  const query = new URLSearchParams(direction)
  return safePage(await request(`/api/conversations/${conversationId}/messages/page?${query}`, { token, signal }))
}

export async function getMessageContext(token, conversationId, messageId, signal) {
  return safePage(await request(`/api/conversations/${conversationId}/messages/${messageId}/context`, { token, signal }))
}

export async function synchronize(token, conversationId, after, messageIds, signal) {
  const data = await request(`/api/conversations/${conversationId}/sync?${new URLSearchParams({ after })}`, { token, signal, body: { message_ids: messageIds } })
  if (!Array.isArray(data?.events) || data.events.length > 100 || !Array.isArray(data.items) || data.items.length > 400 || !Array.isArray(data.missing_ids) || data.missing_ids.length > 400 || !Number.isSafeInteger(data.event_id) || typeof data.next_cursor !== 'string') throw apiError(GENERIC_ERROR)
  return { ...data, items: data.items.map(item => ({ ...safeMessage(item), _seq: data.event_id, _cursor: data.cursors[item.id] })) }
}

export async function markConversationRead(token, conversationId, through, signal, read = true) {
  return request(`/api/conversations/${conversationId}/receipts`, { token, signal, body: { through, read } })
}

export async function getPresence(token, signal) {
  const data = await request('/api/users/presence', { token, signal })
  if (!Array.isArray(data?.users) || !Number.isFinite(Date.parse(data.server_time)) || !data.users.every(item => Number.isSafeInteger(item.user_id) && typeof item.online === 'boolean' && (item.last_seen_at === null || Number.isFinite(Date.parse(item.last_seen_at))))) throw apiError(GENERIC_ERROR)
  return data
}
