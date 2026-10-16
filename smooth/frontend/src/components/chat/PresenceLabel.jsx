import { formatLastSeen } from '../../utils/formatLastSeen.js'
export default function PresenceLabel({ online, typing, lastSeen, now }) {
  return <span>{typing ? 'typing...' : online ? 'online' : formatLastSeen(lastSeen, now)}</span>
}
