import { Fragment } from 'react'
import { sameGroup, dayLabel } from '../../utils/groupMessages.js'
import MessageBubble from './MessageBubble.jsx'
export default function MessageList({ messages, user, selectedUser, timeline, highlightId, ...props }) {
  return <ol className="message-list">
    {messages.map((message, index) => {
      const previous = messages[index - 1]
      const gap = previous && timeline.isGap(previous, message)
      const day = dayLabel(message.created_at)
      return <Fragment key={message.id}>
        {gap && <li className="history-gap"><button type="button" disabled={timeline.busy} className="text-button min-h-9" onClick={() => timeline.loadGap(previous)}>Load messages in this gap</button></li>}
        {(!previous || day !== dayLabel(previous.created_at)) && <li className="date-separator"><span>{day}</span></li>}
        <MessageBubble {...props} message={message} own={message.sender_id === user.id} name={selectedUser.username} grouped={sameGroup(previous, message, gap)} highlighted={highlightId === message.id} onNavigate={timeline.navigate} onChanged={timeline.retrySync} />
      </Fragment>
    })}
  </ol>
}
