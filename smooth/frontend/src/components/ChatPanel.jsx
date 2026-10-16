import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { sendMessage, sendImage, editMessage, deleteMessage } from '../services/api.js'
import MessageList from './chat/MessageList.jsx'
import MessageActionMenu from './chat/MessageActionMenu.jsx'
import ImageViewer from './chat/ImageViewer.jsx'
import { replyPreview, replyText } from './chat/MessageBubble.jsx'
import useMessageActions from '../hooks/useMessageActions.js' 
import ChatHeader from './chat/ChatHeader.jsx'
import ChatComposer from './chat/ChatComposer.jsx'
import useTimeline from '../hooks/useTimeline.js'

export default function ChatPanel({ user, selectedUser, initialConversation, onConversationOpened, onMessageSent, onMessageMutated, subscribeToMutations, subscribeToSync, token, onUnauthorized, subscribeToMessages, subscribeToStatus, acknowledge, subscribeToTyping, sendTyping, isOnline, onBack }) {
  const [retryAttempt, setRetryAttempt] = useState(0)
  const [content, setContent] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState('')
  const [selectedImage, setSelectedImage] = useState(null)
  const [imagePreview, setImagePreview] = useState('')
  const pending = useRef(false)
  const sendController = useRef(null)
  const history = useRef(null)
  const conversationId = useRef(null)
  const [otherTyping, setOtherTyping] = useState(false)
  const localTyping = useRef(false)
  const typingStartedAt = useRef(0)
  const typingTimer = useRef(null)
  const remoteTypingTimer = useRef(null)
  const [editingId, setEditingId] = useState(null)
  const [editContent, setEditContent] = useState('')
  const [actionError, setActionError] = useState('')
  const [actionBusy, setActionBusy] = useState(false)
  const actionPending = useRef(false)
  const actionController = useRef(null)
  const [replyTarget, setReplyTarget] = useState(null)
  const [photo, setPhoto] = useState(null)
  const closePhoto = useCallback(() => setPhoto(null), [])

  function replyName(preview) {
    return preview.sender_id === user.id ? 'You' : selectedUser.username
  }

  useEffect(() => {
    if (!selectedImage) { setImagePreview(''); return }
    const url = URL.createObjectURL(selectedImage)
    setImagePreview(url)
    return () => URL.revokeObjectURL(url)
  }, [selectedImage])

  function chooseImage(file) {
    if (!file) return
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 8 * 1024 * 1024) {
      setSendError('Choose a JPEG, PNG, or WEBP image of 8 MB or smaller.')
      return
    }
    setSelectedImage(file)
    setSendError('')
  }

  const atBottom = useRef(true)
  const scrollAnchor = useRef(null)
  const navigationTimer = useRef(null)
  const positioned = useRef(false)
  const [highlightId, setHighlightId] = useState(null)
  const captureScroll = useCallback((reason) => {
    const element = history.current
    if (!element) return null
    const rect = element.getBoundingClientRect()
    const visible = [...element.querySelectorAll('[data-message-id]')].filter(row => row.getBoundingClientRect().bottom > rect.top)
    const anchors = visible.slice(0, 3).map(row => ({ id: Number(row.dataset.messageId), top: row.getBoundingClientRect().top - rect.top }))
    scrollAnchor.current = { anchors, scrollTop: element.scrollTop, bottom: ['latest', 'reset'].includes(reason) || (atBottom.current && !['older', 'newer', 'context'].includes(reason)) }
    return anchors[0]
  }, [])
  const reconcileComposer = useCallback((items, missing) => {
    setReplyTarget(current => {
      if (!current || missing.includes(current.id)) return null
      const updated = items.find(message => message.id === current.id)
      if (!updated) return current
      const preview = replyPreview(updated)
      return preview.content === current.content && preview.attachment_kind === current.attachment_kind ? current : preview
    })
    setEditingId(current => missing.includes(current) ? null : current)
  }, [])
  const timeline = useTimeline({ token, selectedUser, initialConversation, onConversationOpened,
    onUnauthorized, subscribeToSync, beforeChange: captureScroll, atBottom,
    onPersistedRead: onMessageSent, retryAttempt, onReconciled: reconcileComposer,
    trackedIds: [replyTarget?.id, editingId].filter(id => id != null) })
  const { messages, conversation, stage, loadError, addMessages } = timeline
  const actions = useMessageActions(messages, history)
  conversationId.current = conversation?.id || null

  useLayoutEffect(() => {
    const element = history.current
    if (!element) return
    const anchor = scrollAnchor.current
    if (timeline.navigationId) {
      const target = element.querySelector(`[data-message-id="${timeline.navigationId}"]`)
      if (target) {
        target.scrollIntoView({ block: 'center', behavior: 'instant' })
        target.focus({ preventScroll: true })
        setHighlightId(timeline.navigationId)
        clearTimeout(navigationTimer.current)
        navigationTimer.current = setTimeout(() => setHighlightId(null), 1800)
        timeline.clearNavigation()
      }
    } else if ((!anchor && !positioned.current) || anchor?.bottom) element.scrollTop = element.scrollHeight
    else if (anchor) {
      const rect = element.getBoundingClientRect()
      const candidate = anchor.anchors.find(item => element.querySelector(`[data-message-id="${item.id}"]`))
      const row = candidate && element.querySelector(`[data-message-id="${candidate.id}"]`)
      if (row) element.scrollTop += row.getBoundingClientRect().top - rect.top - candidate.top
      else element.scrollTop = anchor.scrollTop
    }
    positioned.current = true
    scrollAnchor.current = null
    atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 64 && !timeline.hasNewer
  }, [messages, stage, timeline.navigationId])

  useEffect(() => {
    // Heights can change after image decoding, reaction updates, or a resize.
    const element = history.current
    if (!element || stage !== 'ready') return
    const observer = new ResizeObserver(() => { if (atBottom.current) element.scrollTop = element.scrollHeight })
    const list = element.querySelector('ol')
    if (list) observer.observe(list)
    return () => observer.disconnect()
  }, [stage])

  useEffect(() => subscribeToMutations((event) => {
    if (event.data.conversation_id !== conversationId.current) return
    if (event.type === 'message:deleted') {
      setEditingId(current => current === event.data.message_id ? null : current)
      setReplyTarget(current => current?.id === event.data.message_id ? null : current)
    } else setReplyTarget(current => current?.id === event.data.id ? replyPreview(event.data) : current)
  }), [subscribeToMutations])

  const stopTyping = useCallback(() => {
    clearTimeout(typingTimer.current)
    if (localTyping.current) sendTyping('typing:stop', conversationId.current)
    localTyping.current = false
  }, [sendTyping])

  function handleContentChange(value) {
    setContent(value)
    if (!value.trim()) return stopTyping()
    if (stage !== 'ready') return
    // Renew at most once every two seconds while input continues, so the
    // recipient's fallback timer also works for long typing sessions.
    if (!localTyping.current || Date.now() - typingStartedAt.current >= 2000) {
      localTyping.current = sendTyping('typing:start', conversationId.current)
      typingStartedAt.current = Date.now()
    }
    clearTimeout(typingTimer.current)
    typingTimer.current = setTimeout(stopTyping, 2000)
  }

  useEffect(() => {
    const unsubscribe = subscribeToTyping((event) => {
      if (event === null) {
        clearTimeout(typingTimer.current)
        localTyping.current = false
      } else if (event.data.conversation_id !== conversationId.current || event.data.user_id !== selectedUser.id || event.data.user_id === user.id) {
        return
      }
      clearTimeout(remoteTypingTimer.current)
      setOtherTyping(event?.type === 'typing:start')
      if (event?.type === 'typing:start') {
        remoteTypingTimer.current = setTimeout(() => setOtherTyping(false), 4000)
      }
    })
    return () => {
      unsubscribe()
      stopTyping()
      clearTimeout(remoteTypingTimer.current)
    }
  }, [subscribeToTyping, stopTyping, selectedUser.id, user.id])

  useEffect(() => () => {
    sendController.current?.abort()
    actionController.current?.abort()
    clearTimeout(navigationTimer.current)
  }, [])

  async function performAction(message, deleting, event) {
    event?.preventDefault()
    if (actionPending.current) return
    const trimmed = editContent.trim()
    if (!deleting && (!trimmed || Array.from(trimmed).length > 2000)) {
      setActionError('Use a message between 1 and 2000 characters.')
      return
    }
    actionPending.current = true
    setActionBusy(true)
    setActionError('')
    const controller = new AbortController()
    actionController.current = controller
    try {
      if (deleting) {
        await deleteMessage(token, message.id, controller.signal)
        if (!controller.signal.aborted) onMessageMutated({ type: 'message:deleted', data: { message_id: message.id, conversation_id: message.conversation_id } })
      } else {
        const saved = await editMessage(token, message.id, trimmed, controller.signal)
        if (!controller.signal.aborted) {
          onMessageMutated({ type: 'message:updated', data: saved })
          setEditingId(null)
        }
      }
    } catch (error) {
      if (controller.signal.aborted || error.name === 'AbortError') return
      if (error.status === 401) onUnauthorized()
      else { setActionError(error.displayMessage || `Unable to ${deleting ? 'delete' : 'edit'} your message. Please try again.`); if (deleting) throw error }
    } finally {
      actionPending.current = false
      if (!controller.signal.aborted) setActionBusy(false)
    }
  }

  async function handleSend(event) {
    event.preventDefault()
    if (pending.current || stage !== 'ready' || !conversation) return
    const trimmed = content.trim()
    if (!trimmed && !selectedImage) return
    if (Array.from(trimmed).length > 2000) {
      setSendError('Use a message between 1 and 2000 characters.')
      return
    }

    pending.current = true
    setSending(true)
    setSendError('')
    const controller = new AbortController()
    sendController.current = controller
    try {
      const message = selectedImage
        ? await sendImage(token, conversation.id, selectedImage, trimmed, controller.signal, replyTarget?.id || null)
        : await sendMessage(token, conversation.id, trimmed, controller.signal, replyTarget?.id || null)
      if (controller.signal.aborted) return
      stopTyping()
      addMessages([message])
      onMessageSent(message)
      setContent('')
      setSelectedImage(null)
      setReplyTarget(null)
    } catch (error) {
      if (controller.signal.aborted || error.name === 'AbortError') return
      if (error.status === 401) {
        onUnauthorized()
      } else {
        setSendError([403, 404, 422].includes(error.status) ? error.displayMessage : 'Unable to send your message. Please try again.')
      }
    } finally {
      pending.current = false
      if (!controller.signal.aborted) setSending(false)
    }
  }

  return (
    <section aria-labelledby="chat-title" className="chat-panel">
      <ChatHeader selectedUser={selectedUser} isOnline={isOnline} otherTyping={otherTyping} onBack={onBack} />
      {stage === 'opening' || stage === 'loading' ? (
        <p role="status" className="min-h-64 py-8 text-sm text-stone-500">{stage === 'opening' ? 'Opening conversation...' : 'Loading messages...'}</p>
      ) : stage === 'error' ? (
        <div className="min-h-64 space-y-4 py-8">
          <p role="alert" className="form-error">{loadError}</p>
          <button type="button" className="secondary-button" onClick={() => setRetryAttempt((attempt) => attempt + 1)}>Try again</button>
        </div>
      ) : (
        <>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            {timeline.hasOlder && <button type="button" className="text-button min-h-9 text-sm" disabled={timeline.busy} onClick={timeline.loadOlder}>Load older messages</button>}
            {timeline.busy && <span role="status" className="text-xs text-stone-500">Updating messages...</span>}
          </div>
          {timeline.syncError && <p role="alert" className="mb-2 text-sm text-stone-600">{timeline.syncError} <button type="button" className="text-button" onClick={timeline.retrySync}>Retry messages</button></p>}
          <div ref={history} tabIndex={0} onScroll={() => {
            const element = history.current
            atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 64 && !timeline.hasNewer
            if (atBottom.current) timeline.clearNew()
          }} role="log" aria-label="Message history" className="chat-history">
            {messages.length === 0 ? (
              <p className="py-8 text-center text-sm leading-6 text-stone-500">No messages yet.<br />Start the conversation.</p>
            ) : (
              <MessageList messages={messages} user={user} selectedUser={selectedUser} timeline={timeline} highlightId={highlightId} token={token} onUnauthorized={onUnauthorized} onOpen={actions.open} onPhoto={setPhoto} />
            )}
          </div>
          <div className="my-2 flex flex-wrap items-center justify-end gap-3">
            {timeline.hasNewer && <button type="button" className="text-button min-h-9 text-sm" disabled={timeline.busy} onClick={timeline.loadNewer}>Load newer messages</button>}
            {(timeline.newCount > 0 || timeline.hasNewer) && <button type="button" className="secondary-button text-sm" disabled={timeline.busy} onClick={timeline.jumpLatest}>{timeline.newCount > 0 ? `${timeline.newCount} new ${timeline.newCount === 1 ? 'message' : 'messages'} · ` : ''}Jump to latest</button>}
          </div>
          {actionError && <p role="alert" className="form-error mb-3">{actionError}</p>}
          <ChatComposer editing={editingId !== null} onCancelEdit={() => setEditingId(null)} content={editingId !== null ? editContent : content} onChange={editingId !== null ? setEditContent : handleContentChange} onSubmit={editingId !== null ? event => performAction(messages.find(message => message.id === editingId) || { id: editingId }, false, event) : handleSend} sending={sending || actionBusy} error={sendError || actionError} image={selectedImage} imagePreview={imagePreview} onImage={chooseImage} onRemoveImage={() => setSelectedImage(null)} replyTarget={replyTarget} replyName={replyName} replyText={replyText} onCancelReply={() => setReplyTarget(null)} />
        </>
      )}
      {actions.target && messages.some(message => message.id === actions.target.id) && <MessageActionMenu target={actions.target} message={messages.find(message => message.id === actions.target.id)} own={messages.find(message => message.id === actions.target.id).sender_id === user.id} onClose={actions.close} token={token} onUnauthorized={onUnauthorized} onChanged={timeline.retrySync} onReply={message => { setEditingId(null); setReplyTarget(replyPreview(message)); requestAnimationFrame(() => document.getElementById('message-content')?.focus()) }} onEdit={message => { setEditingId(message.id); setEditContent(message.content); setActionError(''); requestAnimationFrame(() => document.getElementById('message-content')?.focus()) }} onDelete={message => performAction(message, true)} />}
      {photo && <ImageViewer attachment={photo} token={token} onUnauthorized={onUnauthorized} onClose={closePhoto} />}
    </section>
  )
}
