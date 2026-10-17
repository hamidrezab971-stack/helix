import Icon from '../ui/Icon.jsx'

export default function EmptyState({ title, children, compact = false }) {
  return <div className={`empty-state ${compact ? 'compact' : ''}`}>
    <span className="empty-state-icon"><Icon name="chat" size={compact ? 24 : 30} /></span>
    <p className="empty-state-title">{title}</p>
    {children && <p className="empty-state-description">{children}</p>}
  </div>
}
