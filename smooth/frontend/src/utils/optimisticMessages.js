// Presentation identity never enters the numeric, authoritative timeline.
export function visiblePending(entries, messages, conversationId) {
  const confirmed = new Set(messages.map(message => message.client_message_id).filter(Boolean))
  return entries.filter(entry => entry.conversation_id === conversationId && !confirmed.has(entry.client_message_id))
}
export function reconcilePending(entries, messages, missing = []) {
  const ids = new Set(messages.map(message => message.client_message_id).filter(Boolean))
  return entries.filter(entry => !ids.has(entry.client_message_id) && !(entry.serverId && missing.includes(entry.serverId)))
}
