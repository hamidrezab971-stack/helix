import Avatar from '../chat/Avatar.jsx'
import EmptyState from '../chat/EmptyState.jsx'

export default function PeopleList({ directory, onlineIds, selectedId, onSelect, onProfile, query }) {
  return <div aria-busy={directory.pending}>
    {directory.pending ? <div className="directory-loading" role={directory.loading ? 'status' : undefined}>{directory.loading && <><span className="loading-spinner" /> Looking for people…</>}</div>
      : directory.error ? <div className="sidebar-error"><p role="alert">{directory.error}</p><button type="button" className="text-button" onClick={directory.retry}>Try again</button></div>
      : directory.users.length === 0 ? <EmptyState compact title={query.trim() ? 'No people found.' : 'No other people yet.'}>{query.trim() ? 'Try a different username.' : 'Other registered users will appear here.'}</EmptyState>
      : <ul aria-label="People" className="people-list">{directory.users.map(person => <li key={person.id} className="identity-row">
        <button type="button" className="row-profile-button" aria-label={`View ${person.username}'s profile`} onClick={() => onProfile?.(person)}><Avatar user={person} online={onlineIds.has(person.id)} /></button>
        <button type="button" className="user-row" aria-pressed={selectedId === person.id} onClick={() => onSelect(person)}>
          <span className="conversation-name" dir="auto">@{person.username}</span>
          <span className="directory-presence" data-online={onlineIds.has(person.id)}>{onlineIds.has(person.id) ? 'online' : 'offline'}</span>
        </button>
      </li>)}</ul>}
  </div>
}
