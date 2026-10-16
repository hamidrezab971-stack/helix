import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import useDialog from '../../hooks/useDialog.js'
import MessageReactionStrip from './MessageReactionStrip.jsx'

export default function MessageActionMenu({ target, message, own, onClose, onReply, onEdit, onDelete, token, onChanged, onUnauthorized }) {
  const ref = useRef(null)
  const [position, setPosition] = useState({ left: 12, top: 12 })
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useDialog(ref, onClose)
  useLayoutEffect(() => {
    const box = ref.current.getBoundingClientRect(), rect = target.rect
    const viewport = window.visualViewport
    const height = viewport?.height || innerHeight
    const offset = viewport?.offsetTop || 0
    const mobile = innerWidth < 768
    const above = rect.top - box.height - 8
    const below = rect.bottom + 8
    const cramped = mobile && (height < innerHeight * 0.8 || (above < offset + 12 && below + box.height > offset + height - 12))
    setPosition({ left: cramped ? 12 : Math.max(12, Math.min(innerWidth - box.width - 12, rect.left)), top: cramped ? Math.max(offset + 12, offset + height - box.height - 12) : above >= offset + 12 ? above : Math.min(offset + height - box.height - 12, below) })
  }, [target, confirm, error])
  async function copy() {
    try { await navigator.clipboard.writeText(message.content); onClose() }
    catch { setError('Unable to copy. Select the message text to copy it.') }
  }
  async function remove() {
    if (busy) return
    setBusy(true); setError('')
    try { await onDelete(message); onClose() }
    catch (error) { setError(error.displayMessage || 'Unable to delete your message. Please try again.'); setBusy(false) }
  }
  return createPortal(<div className="chat-overlay" onPointerDown={event => { if (event.target === event.currentTarget && !busy) onClose() }}>
    <div ref={ref} style={position} role="dialog" aria-modal="true" aria-label={confirm ? 'Delete this message?' : 'Message actions'} className="message-menu" aria-busy={busy}>
      {confirm ? <><p className="p-3 text-sm">Delete this message?</p><button type="button" disabled={busy} className="danger" onClick={remove}>{busy ? 'Deleting...' : 'Delete message'}</button><button type="button" disabled={busy} onClick={() => setConfirm(false)}>Cancel</button></> : <>
        <MessageReactionStrip picker message={message} token={token} onChanged={onChanged} onUnauthorized={onUnauthorized} onComplete={onClose} />
        <button type="button" onClick={() => { onClose(); onReply(message) }}>Reply</button>
        {message.content && <button type="button" onClick={copy}>Copy</button>}
        {own && !message.attachment && <button type="button" onClick={() => { onClose(); onEdit(message) }}>Edit</button>}
        {own && <button type="button" className="danger" onClick={() => setConfirm(true)}>Delete</button>}
      </>}
      {error && <p role="alert" className="form-error">{error}</p>}
      <button type="button" className="sr-only" onClick={onClose}>Close message actions</button>
    </div>
  </div>, document.body)
}
