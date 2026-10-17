import Icon from '../ui/Icon.jsx'
export default function ComposerAttachment({ url, name, disabled, onRemove }) {
  return <div className="composer-attachment">
    <img id="composer-image-preview" src={url} alt="Selected image preview" />
    <span className="min-w-0 flex-1"><strong className="block">Photo ready to send</strong><span className="block truncate">{name}</span></span>
    <button type="button" className="icon-button" aria-label="Remove image" disabled={disabled} onClick={onRemove}><Icon name="close" size={18} /></button>
  </div>
}
