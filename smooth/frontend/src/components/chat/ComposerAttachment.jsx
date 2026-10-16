export default function ComposerAttachment({ url, name, disabled, onRemove }) {
  return <div className="composer-attachment">
    <img src={url} alt="Selected image preview" />
    <span className="truncate text-xs">{name}</span>
    <button type="button" className="icon-button" aria-label="Remove image" disabled={disabled} onClick={onRemove}>×</button>
  </div>
}
