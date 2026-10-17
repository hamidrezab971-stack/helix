import Avatar from './Avatar.jsx'
import { utcDate } from '../../utils/formatLastSeen.js'
import useConversationGesture from '../../hooks/useConversationGesture.js'
import Icon from '../ui/Icon.jsx'

function recentTime(timestamp) {
  const date = utcDate(timestamp), today = new Date()
  if (!Number.isFinite(date.getTime())) return ''
  if (date.toDateString() === today.toDateString()) return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(date)
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date)
}

export default function ConversationListItem({ conversation, userId, selected, active, online, onSelect, onProfile, onActions, removing = false }) {
  const gesture = useConversationGesture(element => onActions?.(conversation, element))
  const peer = conversation.other_user, message = conversation.last_message
  const text = message?.content.replace(/\s+/g, ' ') || ''
  const preview = message ? `${message.sender_id === userId ? 'You: ' : ''}${message.attachment ? `Photo${text ? ` · ${text}` : ''}` : text}` : 'No messages yet.'
  const unread = !active && conversation.unread_count > 0 ? conversation.unread_count : 0
  return <li className="identity-row conversation-item" data-conversation-id={conversation.id} data-removing={removing} inert={removing ? true : undefined}>
    <button type="button" className="row-profile-button" aria-label={`View ${peer.username}'s profile`} onClick={() => onProfile?.(peer)}><Avatar user={peer} online={online} /></button>
    <button type="button" className="recent-row" aria-pressed={selected} {...gesture} onKeyDown={event => {
      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); onActions?.(conversation, event.currentTarget) }
    }} onClick={() => onSelect(peer, conversation)}>
      <span className="conversation-summary">
        <span className="conversation-topline"><span className="conversation-name">@{peer.username}</span>{message && <time dateTime={message.created_at} title={message.created_at}>{recentTime(message.created_at)}</time>}</span>
        <span className="conversation-bottomline"><span className="conversation-preview" aria-label="Last message preview" dir="auto">{preview}</span>
          {unread > 0 && <span className="unread-badge" aria-label={`${unread} unread ${unread === 1 ? 'message' : 'messages'}`}>{unread > 99 ? '99+' : unread}</span>}
        </span>
      </span>
    </button>
    {onActions && <button type="button" className="conversation-more" aria-label={`Chat actions for ${peer.username}`} onClick={event => onActions(conversation, event.currentTarget.closest('li'))}><Icon name="more" size={18} /></button>}
  </li>
}
