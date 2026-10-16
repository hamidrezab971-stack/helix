import AttachmentImage from '../AttachmentImage.jsx'
import ReactionBar from '../ReactionBar.jsx'
import MessageStatus from './MessageStatus.jsx'
export function replyPreview(message) {
  return { id: message.id, sender_id: message.sender_id, content: Array.from(message.content).slice(0, 200).join(''), attachment_kind: message.attachment?.kind || null }
}
export function replyText(preview) { return preview.attachment_kind === 'image' ? `Photo${preview.content ? ` · ${preview.content}` : ''}` : preview.content }
export default function MessageBubble({ message, own, name, token, onUnauthorized, onOpen, onPhoto, onNavigate, onChanged, grouped, highlighted }) {
  function open(event) {
    if (event.target.closest('button, a') || window.getSelection()?.toString()) return
    onOpen(message, event.currentTarget)
  }
  return <li tabIndex={-1} data-message-id={message.id} data-highlighted={highlighted} data-grouped={grouped} className={`message-row ${own ? 'outgoing' : 'incoming'}`}>
    <div role="button" tabIndex={0} aria-label={`Actions for ${own ? 'your' : name + "’s"} message`} aria-haspopup="dialog" className={`message-bubble ${message.attachment ? 'media-bubble' : ''} ${message.attachment && !message.content ? 'photo-only' : ''}`} data-own={own} onClick={open} onContextMenu={event => { if (!window.getSelection()?.toString()) { event.preventDefault(); onOpen(message, event.currentTarget) } }} onKeyDown={event => { if (event.target === event.currentTarget && ['Enter', ' '].includes(event.key)) { event.preventDefault(); onOpen(message, event.currentTarget) } }}>
      <span className="sr-only">{own ? 'You' : name}: </span>
      {message.reply_to && <button type="button" aria-label="Reply preview" className="message-quote" onClick={() => onNavigate(message.reply_to.id)}><strong className="block">{message.reply_to.sender_id === message.sender_id && own ? 'You' : 'Reply'}</strong><span className="block truncate">{replyText(message.reply_to)}</span></button>}
      {message.attachment && <AttachmentImage attachment={message.attachment} token={token} onUnauthorized={onUnauthorized} onOpen={onPhoto} />}
      {message.content && <span className="message-text">{message.content}</span>}
      <MessageStatus message={message} own={own} />
    </div>
    <ReactionBar message={message} token={token} onChanged={onChanged} onUnauthorized={onUnauthorized} />
  </li>
}
