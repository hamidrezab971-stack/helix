import PresenceLabel from './PresenceLabel.jsx'
export default function ChatHeader({ selectedUser, isOnline, otherTyping, onBack, lastSeen, now }) {
  return <header className="chat-header">
    <button type="button" className="icon-button mobile-back" aria-label="Back to chats" onClick={onBack}>←</button>
    <span className="chat-avatar" aria-hidden="true">{selectedUser.username.slice(0, 1).toUpperCase()}</span>
    <div className="min-w-0">
      <h2 id="chat-title" className="truncate font-semibold">@{selectedUser.username}</h2>
      <p className="chat-presence" aria-label="Contact presence"><PresenceLabel online={isOnline} typing={otherTyping} lastSeen={lastSeen} now={now} /></p>
      <span role="status" aria-label="Typing indicator" className="sr-only">{otherTyping ? `${selectedUser.username} is typing...` : ''}</span>
    </div>
  </header>
}
