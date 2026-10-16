import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { attachmentBlob } from '../AttachmentImage.jsx'
import useDialog from '../../hooks/useDialog.js'
export default function ImageViewer({ attachment, token, onClose, onUnauthorized }) {
  const ref = useRef(null), start = useRef(null)
  const [url, setUrl] = useState(''), [error, setError] = useState('')
  useDialog(ref, onClose)
  useEffect(() => {
    const controller = new AbortController(); let objectUrl
    attachmentBlob(token, attachment.id, controller.signal).then(blob => {
      if (!controller.signal.aborted) { objectUrl = URL.createObjectURL(blob); setUrl(objectUrl) }
    }).catch(error => { if (!controller.signal.aborted) { if (error.status === 401) onUnauthorized(); else setError('Unable to open image. Close and try again.') } })
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [attachment.id, token, onUnauthorized])
  return createPortal(<div className="image-viewer" ref={ref} role="dialog" aria-modal="true" aria-label="Photo viewer" onClick={event => { if (event.target === event.currentTarget) onClose() }} onTouchStart={event => { start.current = event.touches[0].clientY }} onTouchEnd={event => { if (start.current != null && Math.abs(event.changedTouches[0].clientY - start.current) > 90) onClose(); start.current = null }}>
    <button type="button" className="viewer-close icon-button" aria-label="Close photo" onClick={onClose}>×</button>
    {url ? <img src={url} alt="Message photo enlarged" /> : <p role={error ? 'alert' : 'status'}>{error || 'Loading image...'}</p>}
  </div>, document.body)
}
