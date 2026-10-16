export default function ReplyEditPreview({ editing, name, text, onCancel, disabled }) {
  return <div aria-label={editing ? 'Edit composer' : 'Reply composer'} className="reply-edit-preview">
    <span className="min-w-0"><strong className="block">{editing ? 'Editing message' : `Replying to ${name}`}</strong><span className="block truncate">{text}</span></span>
    <button type="button" className="icon-button" aria-label={editing ? 'Cancel edit' : 'Cancel reply'} disabled={disabled} onClick={onCancel}>×</button>
  </div>
}
