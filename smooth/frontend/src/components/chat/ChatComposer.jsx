import { useRef } from 'react'
import useAutoResizeComposer from '../../hooks/useAutoResizeComposer.js'
import ComposerAttachment from './ComposerAttachment.jsx'
import ReplyEditPreview from './ReplyEditPreview.jsx'
import Icon from '../ui/Icon.jsx'
import ComposerSlot from './ComposerSlot.jsx'
import { shouldSendOnEnter } from '../../utils/messageInteractions.js'

export default function ChatComposer({ content, onChange, onSubmit, sending, error, image, imagePreview, preparingImage, onPreviewError, onImage, onRemoveImage, replyTarget, replyName, replyText, onCancelReply, editing, onCancelEdit, disabled }) {
  const imageInput = useRef(null)
  const textarea = useAutoResizeComposer(content)
  const touchInput = useRef(false)
  const selection = useRef(0)
  const removeImage = () => {
    onRemoveImage()
    selection.current++
    if (imageInput.current) imageInput.current.value = ''
  }
  return <form onSubmit={onSubmit} aria-label={editing ? 'Edit message' : 'Send message'} aria-busy={sending} className="chat-composer">
    <ComposerSlot open={Boolean(replyTarget || editing)}>{(replyTarget || editing) && <ReplyEditPreview editing={editing} name={replyTarget && replyName(replyTarget)} text={editing ? 'Update your message' : replyText(replyTarget)} onCancel={editing ? onCancelEdit : onCancelReply} disabled={sending} />}</ComposerSlot>
    <ComposerSlot open={Boolean((image || imagePreview || preparingImage) && !editing)}>{(image || imagePreview || preparingImage) && !editing && <ComposerAttachment image={image} url={imagePreview} name={image?.name} preparing={preparingImage} onError={onPreviewError} disabled={sending} onRemove={removeImage} />}</ComposerSlot>
    {error && <p role="alert" className="form-error mb-2">{error}</p>}
    <div className="composer-controls">
      <input ref={imageInput} type="file" accept="image/jpeg,image/png,image/webp" aria-label="Choose image" className="hidden" onChange={event => {
        const input = event.currentTarget, id = ++selection.current
        onImage(input.files?.[0], () => { if (id === selection.current) input.value = '' })
      }} />
      {!editing && <button type="button" className="icon-button attachment-button" disabled={sending || preparingImage || disabled} aria-label="Image" title="Attach image" onMouseDown={event => event.preventDefault()} onClick={() => imageInput.current?.click()}><Icon name="image" /></button>}
      <label htmlFor="message-content" className="sr-only">{editing ? 'Edit message text' : image ? 'Caption (optional)' : 'Message'}</label>
      <textarea ref={textarea} id="message-content" rows={1} className="composer-input" dir="auto" placeholder="Message…" maxLength={2000} readOnly={sending} disabled={disabled} aria-describedby="message-hint" value={content} onPointerDown={event => { touchInput.current = event.pointerType === 'touch' }} onChange={event => onChange(event.target.value)} onKeyDown={event => {
        const mobile = touchInput.current || matchMedia('(pointer: coarse)').matches
        if (shouldSendOnEnter({ key: event.key, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing, keyCode: event.nativeEvent.keyCode }, mobile)) { event.preventDefault(); event.currentTarget.form.requestSubmit() }
      }} />
      <button type="submit" className="send-button" aria-label={editing ? 'Save' : 'Send'} aria-busy={sending || preparingImage} onMouseDown={event => event.preventDefault()} disabled={sending || preparingImage || disabled || (!content.trim() && (editing || !image))}>{sending || preparingImage ? <span className="loading-spinner" aria-hidden="true" /> : <Icon name={editing ? 'check' : 'send'} />}</button>
    </div>
    <p id="message-hint" className="sr-only">Up to 2000 characters. On desktop, Enter to send; Shift+Enter for a new line. On touch devices, Enter adds a line. Use Send to send.</p>
  </form>
}
