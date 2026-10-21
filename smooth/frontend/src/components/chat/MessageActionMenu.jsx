import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import useDialog from '../../hooks/useDialog.js'
import MessageReactionStrip from './MessageReactionStrip.jsx'
import Icon from '../ui/Icon.jsx'
import { positionMessageMenu } from '../../utils/messageInteractions.js'

export default function MessageActionMenu({ target, message, own, onClose, onReply, onEdit, onDelete, token, onChanged, onUnauthorized, reactionRequests }) {
  const ref = useRef(null)
  const [position, setPosition] = useState({ left: 12, top: 12 })
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const closing = useRef(false), mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const requestClose = useCallback(async (after) => {
    if (closing.current) return
    closing.current = true
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches && ref.current?.animate) {
      try { await ref.current.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(4px) scale(.98)' }], { duration: 150, easing: 'ease-out', fill: 'forwards' }).finished } catch { /* Unmount can cancel motion. */ }
    }
    if (!mounted.current) return
    onClose()
    if (typeof after === 'function') after()
  }, [onClose])
  useDialog(ref, requestClose)
  useLayoutEffect(() => {
    const element = ref.current
    function place() {
      const viewport = window.visualViewport
      const next = positionMessageMenu(target.rect, { width: element.offsetWidth, height: element.offsetHeight }, { width: viewport?.width || innerWidth, height: viewport?.height || innerHeight, left: viewport?.offsetLeft || 0, top: viewport?.offsetTop || 0 })
      setPosition(current => Object.keys(next).every(key => current[key] === next[key]) ? current : next)
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(element)
    return () => observer.disconnect()
  }, [target])
  async function copy() {
    try { await navigator.clipboard.writeText(message.content); requestClose() }
    catch { setError('Unable to copy. Select the message text to copy it.') }
  }
  async function remove() {
    if (busy) return
    setBusy(true); setError('')
    try { await onDelete(message); requestClose() }
    catch (error) { setError(error.displayMessage || 'Unable to delete your message. Please try again.'); setBusy(false) }
  }
  return createPortal(<div className="chat-overlay" onWheel={event => { if (!ref.current?.contains(event.target) && !busy) requestClose() }} onPointerDown={event => { if (event.target === event.currentTarget && !busy) requestClose() }}>
    <div ref={ref} style={position} role="dialog" aria-modal="true" aria-label={confirm ? 'Delete this message?' : 'Message actions'} className="message-menu" aria-busy={busy}>
      {confirm ? <><p className="p-3 text-sm">Delete this message?</p><button type="button" disabled={busy} className="danger" onClick={remove}>{busy ? 'Deleting...' : 'Delete message'}</button><button type="button" disabled={busy} onClick={() => setConfirm(false)}>Cancel</button></> : <>
        <MessageReactionStrip requests={reactionRequests} picker message={message} token={token} onChanged={onChanged} onUnauthorized={onUnauthorized} onComplete={requestClose} />
        <button type="button" onClick={() => requestClose(() => onReply(message))}><Icon name="reply" />Reply</button>
        {message.content && <button type="button" onClick={copy}><Icon name="copy" />Copy</button>}
        {own && !message.attachment && <button type="button" onClick={() => requestClose(() => onEdit(message))}><Icon name="edit" />Edit</button>}
        {own && <button type="button" className="danger" onClick={() => setConfirm(true)}><Icon name="trash" />Delete</button>}
      </>}
      {error && <p role="alert" className="form-error">{error}</p>}
      <button type="button" className="menu-close" onClick={() => requestClose()}>Close message actions</button>
    </div>
  </div>, document.body)
}
