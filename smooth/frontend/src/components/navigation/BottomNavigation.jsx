import Icon from '../ui/Icon.jsx'

const items = [['chats', 'chat', 'Chats'], ['contacts', 'people', 'Contacts'], ['settings', 'settings', 'Settings'], ['profile', 'person', 'Profile']]

export default function BottomNavigation({ screen, onNavigate }) {
  return <nav className="bottom-navigation" aria-label="Main navigation">{items.map(([destination, icon, label]) =>
    <button type="button" key={destination} aria-current={screen === destination ? 'page' : undefined} onClick={() => onNavigate(destination)}><span><Icon name={icon} size={21} /></span>{label}</button>
  )}</nav>
}
