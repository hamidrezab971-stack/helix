import { useRef } from 'react'
import useAutoResizeComposer from '../../hooks/useAutoResizeComposer.js'
import ComposerAttachment from './ComposerAttachment.jsx'
import ReplyEditPreview from './ReplyEditPreview.jsx'

export default function ChatComposer({ content, onChange, onSubmit, sending, error, image, imagePreview, onImage, onRemoveImage, replyTarget, replyName, replyText, onCancelReply, editing, onCancelEdit, disabled }) {
  const imageInput = useRef(null)
  const textarea = useAutoResizeComposer(content)
  return <form onSubmit={onSubmit} aria-label={editing ? 'Edit message' : 'Send message'} aria-busy={sending} className="chat-composer">
    {(replyTarget || editing) && <ReplyEditPreview editing={editing} name={replyTarget && replyName(replyTarget)} text={editing ? 'Update your message' : replyText(replyTarget)} onCancel={editing ? onCancelEdit : onCancelReply} disabled={sending} />}
    {imagePreview && <ComposerAttachment url={imagePreview} name={image?.name} disabled={sending} onRemove={onRemoveImage} />}
    {error && <p role="alert" className="form-error mb-2">{error}</p>}
    <div className="composer-controls">
      <input ref={imageInput} type="file" accept="image/jpeg,image/png,image/webp" aria-label="Choose image" className="hidden" onChange={event => { onImage(event.target.files?.[0]); event.target.value = '' }} />
      {!editing && <button type="button" className="icon-button" disabled={sending || disabled} aria-label="Image" title="Attach image" onClick={() => imageInput.current?.click()}>＋</button>}
      <label htmlFor="message-content" className="sr-only">{editing ? 'Edit message text' : image ? 'Caption (optional)' : 'Message'}</label>
      <textarea ref={textarea} id="message-content" rows={1} className="composer-input" placeholder="Write a message..." maxLength={2000} disabled={sending || disabled} aria-describedby="message-hint" value={content} onChange={event => onChange(event.target.value)} onKeyDown={event => {
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form.requestSubmit() }
      }} />
      <button type="submit" className="send-button" aria-label={editing ? 'Save' : 'Send'} disabled={sending || disabled || (!content.trim() && !image)}><span aria-hidden="true">{editing ? '✓' : '↑'}</span></button>
    </div>
    <p id="message-hint" className="sr-only">Up to 2000 characters. Enter to send; Shift+Enter for a new line.</p>
  </form>
}
