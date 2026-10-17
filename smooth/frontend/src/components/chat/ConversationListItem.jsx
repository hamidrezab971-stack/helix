import Avatar from './Avatar.jsx'
import { utcDate } from '../../utils/formatLastSeen.js'

function recentTime(timestamp) {
  const date = utcDate(timestamp), today = new Date()
  if (!Number.isFinite(date.getTime())) return ''
  if (date.toDateString() === today.toDateString()) return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(date)
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date)
}

export default function ConversationListItem({ conversation, userId, selected, active, online, onSelect, onProfile }) {
  const peer = conversation.other_user, message = conversation.last_message
  const text = message?.content.replace(/\s+/g, ' ') || ''
  const preview = message ? `${message.sender_id === userId ? 'You: ' : ''}${message.attachment ? `Photo${text ? ` · ${text}` : ''}` : text}` : 'No messages yet.'
  const unread = !active && conversation.unread_count > 0 ? conversation.unread_count : 0
  return <li className="identity-row">
    <button type="button" className="row-profile-button" aria-label={`View ${peer.username}'s profile`} onClick={() => onProfile?.(peer)}><Avatar user={peer} online={online} /></button>
    <button type="button" className="recent-row" aria-pressed={selected} onClick={() => onSelect(peer, conversation)}>
      <span className="conversation-summary">
        <span className="conversation-topline"><span className="conversation-name">@{peer.username}</span>{message && <time dateTime={message.created_at} title={message.created_at}>{recentTime(message.created_at)}</time>}</span>
        <span className="conversation-bottomline"><span className="conversation-preview" aria-label="Last message preview" dir="auto">{preview}</span>
          {unread > 0 && <span className="unread-badge" aria-label={`${unread} unread ${unread === 1 ? 'message' : 'messages'}`}>{unread > 99 ? '99+' : unread}</span>}
        </span>
      </span>
    </button>
  </li>
}
