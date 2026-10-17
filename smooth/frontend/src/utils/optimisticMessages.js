// The server scopes UUIDs to senders. Canonical IDs remain numeric and separate.
const identity = message => `${message.sender_id}:${message.conversation_id}:${message.client_message_id}`
export function visiblePending(entries, messages, conversationId) {
  const confirmed = new Set(messages.filter(message => message.client_message_id).map(identity))
  return entries.filter(entry => entry.conversation_id === conversationId && !confirmed.has(identity(entry)))
}
export function reconcilePending(entries, messages, missing = []) {
  const ids = new Set(messages.filter(message => message.client_message_id).map(identity))
  return entries.filter(entry => !ids.has(identity(entry)) && !(entry.serverId && missing.includes(entry.serverId)))
}
