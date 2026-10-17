import PresenceLabel from './PresenceLabel.jsx'
import Avatar from './Avatar.jsx'
import Icon, { HelixMark } from '../ui/Icon.jsx'
export default function ChatHeader({ selectedUser, isOnline, otherTyping, onBack, lastSeen, now, onProfile }) {
  return <header className="chat-header">
    <button type="button" className="icon-button mobile-back" aria-label="Back" onClick={onBack}><Icon name="back" /></button>
    <button type="button" className="header-profile-button" aria-label={`View ${selectedUser.username}'s profile`} onClick={() => onProfile?.(selectedUser)}><Avatar user={selectedUser} online={isOnline} /></button>
    <div className="min-w-0">
      <h2 id="chat-title" className="truncate font-semibold"><button type="button" onClick={() => onProfile?.(selectedUser)}>@{selectedUser.username}</button></h2>
      <p className="chat-presence" aria-label="Contact presence"><PresenceLabel online={isOnline} typing={otherTyping} lastSeen={lastSeen} now={now} /></p>
      <span role="status" aria-label="Typing indicator" className="sr-only">{otherTyping ? `${selectedUser.username} is typing...` : ''}</span>
    </div>
    <HelixMark className="header-mark" />
  </header>
}
