import { useEffect, useState } from 'react'
import Icon from '../ui/Icon.jsx'
import { activeSendStates } from '../../utils/chatImage.js'

const labels = { queued: 'Preparing…', uploading: 'Uploading…', sending: 'Sending…', sent: 'Sent', failed: 'Failed', retrying: 'Retrying…', cancelled: 'Cancelled' }
export default function PendingMessage({ entry, onRetry, onDismiss, onCancel }) {
  const [url, setUrl] = useState('')
  const [previewError, setPreviewError] = useState(false)
  useEffect(() => {
    setPreviewError(false)
    if (!entry.file) { setUrl(''); return }
    const objectUrl = URL.createObjectURL(entry.file); setUrl(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [entry.file])
  const dimensions = entry.dimensions
  const scale = dimensions ? Math.min(1, 320 / dimensions.width, 360 / dimensions.height) : 1
  const busy = activeSendStates.has(entry.state)
  const progress = entry.state === 'uploading' ? entry.progress : null
  return <li data-enter={performance.now() - entry.enteredAt < 250} className="message-row outgoing pending-message" data-local-id={entry.localId} data-state={entry.state}>
    <div className={`message-bubble ${url ? 'media-bubble' : ''} ${url && !entry.content ? 'photo-only' : ''}`} data-own="true">
      {entry.reply_to && <span className="message-quote">Replying to {entry.reply_to.content || 'Photo'}</span>}
      {url && (previewError ? <span className="media-status">Photo preview unavailable. Your photo is kept for retry.</span> : <img className="pending-photo" style={dimensions ? { width: dimensions.width * scale, height: dimensions.height * scale } : undefined} src={url} alt="Pending message photo" onError={() => setPreviewError(true)} />)}
      {entry.content && <span dir="auto" className="message-text">{entry.content}</span>}
      <span className="message-metadata" role="status">{busy ? <span className="loading-spinner" aria-hidden="true" /> : <Icon name={entry.state === 'failed' ? 'alert' : entry.state === 'cancelled' ? 'close' : 'check'} size={14} />}{labels[entry.state] || 'Preparing…'}</span>
      {entry.state === 'uploading' && <progress className="upload-progress" aria-label="Image upload progress" max={progress?.total || 1} value={progress ? progress.loaded : undefined} />}
    </div>
    {busy && onCancel && <button type="button" className="text-button pending-cancel" onClick={() => onCancel(entry.localId)}><Icon name="close" size={14} />Cancel send</button>}
    {entry.state === 'cancelled' && <div className="pending-error"><p>Upload stopped. If already received, it may still appear in your chat.</p><button type="button" className="text-button" onClick={() => onDismiss(entry.localId)}><Icon name="close" size={16} />Dismiss message</button></div>}
    {entry.state === 'failed' && <div className="pending-error"><p role="alert">{entry.error}</p>{!entry.terminal && <button type="button" className="text-button" onClick={() => onRetry(entry.localId)}><Icon name="retry" size={16} />Retry message</button>}<button type="button" className="text-button" onClick={() => onDismiss(entry.localId)}><Icon name="close" size={16} />Dismiss message</button></div>}
  </li>
}
