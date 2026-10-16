import { useEffect, useState } from 'react'
export default function PendingMessage({ entry, onRetry, onDismiss }) {
  const [url, setUrl] = useState('')
  useEffect(() => {
    if (!entry.file) return
    const objectUrl = URL.createObjectURL(entry.file); setUrl(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [entry.file])
  return <li className="message-row outgoing pending-message" data-local-id={entry.localId} data-state={entry.state}>
    <div className={`message-bubble ${url ? 'media-bubble' : ''} ${url && !entry.content ? 'photo-only' : ''}`} data-own="true">
      {entry.reply_to && <span className="message-quote">Replying to {entry.reply_to.content || 'Photo'}</span>}
      {url && <img className="pending-photo" src={url} alt="Pending message photo" />}
      {entry.content && <span className="message-text">{entry.content}</span>}
      <span className="message-metadata" role="status">{entry.state === 'failed' ? 'Failed' : entry.state === 'sent' ? 'Sent' : entry.file ? 'Uploading…' : 'Sending…'}</span>
    </div>
    {entry.state === 'failed' && <div className="pending-error"><p role="alert">{entry.error}</p>{!entry.terminal && <button type="button" className="text-button" onClick={() => onRetry(entry.localId)}>Retry message</button>}<button type="button" className="text-button" onClick={() => onDismiss(entry.localId)}>Dismiss message</button></div>}
  </li>
}
