import { memo } from 'react'
import AttachmentImage from '../AttachmentImage.jsx'
import ReactionBar from '../ReactionBar.jsx'
import MessageStatus from './MessageStatus.jsx'
import useMessageGesture from '../../hooks/useMessageGesture.js'
import Icon from '../ui/Icon.jsx'
export function replyPreview(message) {
  return { id: message.id, sender_id: message.sender_id, content: Array.from(message.content).slice(0, 200).join(''), attachment_kind: message.attachment?.kind || null }
}
export function replyText(preview) { return preview.attachment_kind === 'image' ? `Photo${preview.content ? ` · ${preview.content}` : ''}` : preview.content }
export default memo(function MessageBubble({ message, own, name, token, onUnauthorized, onOpen, onPhoto, onNavigate, onChanged, grouped, highlighted, enter, reactionRequests, active, userId }) {
  const gesture = useMessageGesture(message, onOpen)
  return <li data-active={active} data-enter={enter} tabIndex={-1} data-message-id={message.id} data-highlighted={highlighted} data-grouped={grouped} className={`message-row ${own ? 'outgoing' : 'incoming'}`}>
    <div role="group" tabIndex={-1} aria-label={`Actions for ${own ? 'your' : name + "’s"} message`} aria-haspopup="dialog" aria-expanded={Boolean(active)} className={`message-bubble ${message.attachment ? 'media-bubble' : ''} ${message.attachment && !message.content ? 'photo-only' : ''}`} data-own={own} {...gesture} onKeyDown={event => { if (event.target === event.currentTarget && (['Enter', ' '].includes(event.key) || (event.shiftKey && event.key === 'F10'))) { event.preventDefault(); onOpen(message, event.currentTarget) } }}>
      <button type="button" className="message-menu-trigger" aria-label="Message actions" aria-haspopup="dialog" aria-expanded={Boolean(active)} onClick={event => onOpen(message, event.currentTarget.closest('.message-bubble'))}><Icon name="more" size={16} /></button>
      <span className="sr-only">{own ? 'You' : name}: </span>
      {message.reply_to && <button type="button" aria-label="Reply preview" className="message-quote" onClick={() => onNavigate(message.reply_to.id)}><strong className="block">{message.reply_to.sender_id === userId ? 'You' : name}</strong><span className="block truncate">{replyText(message.reply_to)}</span></button>}
      {message.attachment && <AttachmentImage attachment={message.attachment} token={token} onUnauthorized={onUnauthorized} onOpen={onPhoto} />}
      {message.content && <span dir="auto" className="message-text">{message.content}</span>}
      <MessageStatus message={message} own={own} />
    </div>
    <ReactionBar requests={reactionRequests} message={message} token={token} onChanged={onChanged} onUnauthorized={onUnauthorized} />
  </li>
})
