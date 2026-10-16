import { useEffect, useRef, useState } from 'react'
import { changeReaction } from '../../services/api.js'
export const choices = [['👍', 'thumbs up'], ['❤️', 'heart'], ['😂', 'laughing'], ['😮', 'surprised'], ['😢', 'sad'], ['👎', 'thumbs down']]

export default function MessageReactionStrip({ message, token, onChanged, onUnauthorized, picker = false, onComplete }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const controller = useRef(null)
  const pending = useRef(false)
  useEffect(() => () => controller.current?.abort(), [])
  async function toggle(emoji) {
    if (pending.current) return
    pending.current = true; setBusy(true); setError('')
    const request = new AbortController(); controller.current = request
    try {
      await changeReaction(token, message.id, emoji, Boolean(message.reactions.find(item => item.emoji === emoji)?.reacted_by_me), request.signal)
      if (request.signal.aborted) return
      // The serialized personalized timeline wins over delayed action responses.
      onChanged(); onComplete?.()
    } catch (error) {
      if (request.signal.aborted) return
      if (error.status === 401) onUnauthorized()
      else setError('Unable to change reaction. Please try again.')
    } finally { pending.current = false; if (!request.signal.aborted) setBusy(false) }
  }
  const items = picker ? choices.map(([emoji]) => ({ emoji, reacted_by_me: Boolean(message.reactions.find(item => item.emoji === emoji)?.reacted_by_me) })) : message.reactions
  if (!items.length) return null
  return <div className="reaction-strip" role="group" aria-label={picker ? 'Choose reaction' : 'Message reactions'} aria-busy={busy}>
    {items.map(item => {
      const name = choices.find(([emoji]) => item.emoji === emoji)[1]
      return <button type="button" key={item.emoji} aria-pressed={item.reacted_by_me} aria-label={picker ? `${item.reacted_by_me ? 'Remove' : 'Add'} ${name} reaction` : `${item.count} ${name} ${item.count === 1 ? 'reaction' : 'reactions'}. ${item.reacted_by_me ? 'Remove your reaction' : 'Add your reaction'}`} disabled={busy} onClick={() => toggle(item.emoji)}>{item.emoji}{!picker && ` ${item.count}`}</button>
    })}
    {error && <span role="alert">{error}</span>}
  </div>
}
