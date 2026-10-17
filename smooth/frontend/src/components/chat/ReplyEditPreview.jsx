import Icon from '../ui/Icon.jsx'
export default function ReplyEditPreview({ editing, name, text, onCancel, disabled }) {
  return <div aria-label={editing ? 'Edit composer' : 'Reply composer'} className="reply-edit-preview">
    <Icon name={editing ? 'edit' : 'reply'} />
    <span className="min-w-0 flex-1"><strong className="block truncate">{editing ? 'Editing message' : `Replying to ${name}`}</strong><span className="block truncate" dir="auto">{text}</span></span>
    <button type="button" className="icon-button" aria-label={editing ? 'Cancel edit' : 'Cancel reply'} disabled={disabled} onClick={onCancel}><Icon name="close" size={18} /></button>
  </div>
}
