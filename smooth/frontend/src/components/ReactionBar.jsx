import { useEffect, useRef, useState } from 'react'
import { changeReaction, getReactions } from '../services/api.js'

const choices = [['👍', 'thumbs up'], ['❤️', 'heart'], ['😂', 'laughing'], ['😮', 'surprised'], ['😢', 'sad'], ['👎', 'thumbs down']]

export default function ReactionBar({ message, token, onChanged, onUnauthorized }) {
  // Seed from personalized history; subsequent state comes only from this
  // user's reaction endpoint, never from a shared message edit event.
  const [summary, setSummary] = useState(message.reactions)
  const [picker, setPicker] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const version = useRef(0)
  const fetchController = useRef(null)
  const actionController = useRef(null)
  const refreshRef = useRef(null)
  const active = useRef(false)
  const pending = useRef(false)

  useEffect(() => {
    active.current = true
    async function refresh() {
      fetchController.current?.abort()
      const controller = new AbortController()
      fetchController.current = controller
      const current = ++version.current
      try {
        const latest = await getReactions(token, message.id, controller.signal)
        if (active.current && !controller.signal.aborted && current === version.current) { setSummary(latest); setError('') }
      } catch (error) {
        if (!active.current || controller.signal.aborted || error.name === 'AbortError') return
        if (error.status === 401) onUnauthorized()
        else setError('Unable to load reactions.')
      }
    }
    refreshRef.current = refresh
    return () => {
      active.current = false
      ++version.current
      fetchController.current?.abort()
      actionController.current?.abort()
    }
  }, [message.id, token, onUnauthorized])

  useEffect(() => {
    ++version.current
    fetchController.current?.abort()
    setSummary(message.reactions)
  }, [message.reactions])

  async function toggle(emoji) {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError('')
    fetchController.current?.abort()
    const current = ++version.current
    const controller = new AbortController()
    actionController.current = controller
    try {
      const removing = Boolean(summary.find(item => item.emoji === emoji)?.reacted_by_me)
      const latest = await changeReaction(token, message.id, emoji, removing, controller.signal)
      if (!active.current || controller.signal.aborted) return
      if (current === version.current) setSummary(latest)
      setPicker(false)
      onChanged()
    } catch (error) {
      if (!active.current || controller.signal.aborted || error.name === 'AbortError') return
      if (error.status === 401) onUnauthorized()
      else setError('Unable to change reaction. Please try again.')
    } finally {
      pending.current = false
      if (active.current && !controller.signal.aborted) setBusy(false)
    }
  }

  return <div className="mt-1 max-w-full text-xs">
    {summary.length > 0 && <div role="group" aria-label="Message reactions" className="mb-1 flex flex-wrap gap-1">
      {summary.map(item => {
        const name = choices.find(([emoji]) => emoji === item.emoji)[1]
        return <button key={item.emoji} type="button" aria-pressed={item.reacted_by_me} aria-label={`${item.count} ${name} ${item.count === 1 ? 'reaction' : 'reactions'}. ${item.reacted_by_me ? 'Remove your reaction' : 'Add your reaction'}`} disabled={busy}
          className={`min-h-8 rounded-full border px-2 ${item.reacted_by_me ? 'border-[#b65339] bg-[#fcf0e9] font-semibold' : 'border-stone-200 bg-white'}`} onClick={() => toggle(item.emoji)}>{item.emoji} {item.count}</button>
      })}
    </div>}
    <button type="button" className="text-button min-h-8" aria-expanded={picker} disabled={busy} onClick={() => setPicker(value => !value)}>React</button>
    {picker && <div role="group" aria-label="Choose reaction" className="flex flex-wrap gap-1 rounded-lg border border-stone-200 bg-white p-1">
      {choices.map(([emoji, name]) => {
        const reacted = Boolean(summary.find(item => item.emoji === emoji)?.reacted_by_me)
        return <button key={emoji} type="button" aria-label={`${reacted ? 'Remove' : 'Add'} ${name} reaction`} aria-pressed={reacted} disabled={busy} className="min-h-9 min-w-9 rounded px-2 text-lg hover:bg-stone-100" onClick={() => toggle(emoji)}>{emoji}</button>
      })}
    </div>}
    {error && <span role="alert" className="block text-red-700">{error} <button type="button" className="underline" onClick={() => refreshRef.current?.()}>Retry reactions</button></span>}
  </div>
}
