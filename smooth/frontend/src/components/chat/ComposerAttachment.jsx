import { useEffect, useState } from 'react'
import Icon from '../ui/Icon.jsx'
export default function ComposerAttachment({ image, url: suppliedUrl, name, preparing, onError, disabled, onRemove }) {
  const [url, setUrl] = useState('')
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    setFailed(false)
    if (!image?.blob) { setUrl(''); return }
    const owned = URL.createObjectURL(image.blob)
    setUrl(owned)
    return () => URL.revokeObjectURL(owned)
  }, [image?.blob])
  // The slot retains this component during its closing animation; its URL
  // therefore lives until the thumbnail actually leaves the document.
  const source = url || suppliedUrl
  return <div className="composer-attachment">
    {failed ? <span className="attachment-preparing" aria-hidden="true"><Icon name="alert" /></span> : preparing || !source ? <span className="attachment-preparing" aria-hidden="true"><span className="loading-spinner" /></span> : <img id="composer-image-preview" src={source} alt="Selected image preview" onError={() => { setFailed(true); onError?.() }} />}
    <span className="min-w-0 flex-1" role="status"><strong className="block">{preparing ? 'Preparing photo…' : 'Photo ready to send'}</strong><span className="block truncate">{name || 'JPEG, PNG or WebP · up to 8 MB'}</span></span>
    <button type="button" className="icon-button" aria-label="Remove image" disabled={disabled} onClick={onRemove}><Icon name="close" size={18} /></button>
  </div>
}
