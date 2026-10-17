import { formatLastSeen } from '../../utils/formatLastSeen.js'
import TypingIndicator from './TypingIndicator.jsx'
export default function PresenceLabel({ online, typing, lastSeen, now }) {
  return <span className="presence-label" data-online={online} data-typing={Boolean(typing)}>{typing && <TypingIndicator />}{typing ? 'typing...' : online ? 'online' : formatLastSeen(lastSeen, now)}</span>
}
