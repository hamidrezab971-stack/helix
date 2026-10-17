import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import useDialog from '../../hooks/useDialog.js'
import { positionMessageMenu } from '../../utils/messageInteractions.js'
import Icon from '../ui/Icon.jsx'

export default function ConversationActions({ target, onClose, onDelete }) {
  const ref = useRef(null), pending = useRef(false), alive = useRef(true), closing = useRef(false)
  const [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [position, setPosition] = useState({ left: 12, top: 12 })
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const close = useCallback(async () => {
    if (pending.current || closing.current) return
    closing.current = true
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches && ref.current?.animate) {
      try { await ref.current.animate([{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(.97)' }], { duration: 160, easing: 'ease-out', fill: 'forwards' }).finished } catch { /* Dismissal may unmount the menu. */ }
    }
    if (alive.current) onClose()
  }, [onClose])
  useDialog(ref, close)
  useLayoutEffect(() => { if (confirm) ref.current?.querySelector('button')?.focus({ preventScroll: true }) }, [confirm])
  useLayoutEffect(() => {
    function place() {
      const viewport = window.visualViewport
      setPosition(positionMessageMenu(target.rect, { width: ref.current.offsetWidth, height: ref.current.offsetHeight },
        { width: viewport?.width || innerWidth, height: viewport?.height || innerHeight,
          left: viewport?.offsetLeft || 0, top: viewport?.offsetTop || 0 }))
    }
    place()
    const observer = new ResizeObserver(place); observer.observe(ref.current)
    window.visualViewport?.addEventListener('resize', place)
    window.visualViewport?.addEventListener('scroll', place)
    window.addEventListener('resize', place)
    return () => { observer.disconnect(); window.visualViewport?.removeEventListener('resize', place); window.visualViewport?.removeEventListener('scroll', place); window.removeEventListener('resize', place) }
  }, [target])
  async function remove() {
    if (pending.current) return
    pending.current = true; setBusy(true); setError('')
    try { await onDelete(target.conversation); pending.current = false; close() }
    catch (error) {
      pending.current = false
      if (alive.current) { setBusy(false); setError(error.displayMessage || 'Unable to delete this chat. Please try again.') }
    }
  }
  return createPortal(<div className="chat-overlay conversation-actions-overlay" onPointerDown={event => { if (event.target === event.currentTarget) close() }}>
    <section ref={ref} style={position} role="dialog" aria-modal="true" aria-label={confirm ? 'Delete this conversation for you?' : 'Chat actions'} className="message-menu conversation-actions" aria-busy={busy}>
      {confirm ? <><h2>Delete this conversation for you?</h2><p>Your chat history will be cleared. The other participant’s messages and account will remain intact. New messages can bring this chat back.</p>
        {error && <p role="alert" className="form-error">{error}</p>}
        <button type="button" disabled={busy} onClick={close}>Cancel</button>
        <button type="button" className="danger" disabled={busy} onClick={remove}><Icon name="trash" />{busy ? 'Deleting…' : 'Delete chat'}</button></> : <>
        <button type="button" className="danger" onClick={() => setConfirm(true)}><Icon name="trash" />Delete Chat</button>
        <button type="button" onClick={close}>Cancel</button></>}
    </section>
  </div>, document.body)
}
