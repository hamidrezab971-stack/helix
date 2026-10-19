import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { editMessage, deleteMessage } from '../services/api.js'
import MessageList from './chat/MessageList.jsx'
import MessageActionMenu from './chat/MessageActionMenu.jsx'
import ImageViewer from './chat/ImageViewer.jsx'
import { replyPreview, replyText } from './chat/MessageBubble.jsx'
import useMessageActions from '../hooks/useMessageActions.js'
import ChatHeader from './chat/ChatHeader.jsx'
import ChatComposer from './chat/ChatComposer.jsx'
import EmptyState from './chat/EmptyState.jsx'
import Icon from './ui/Icon.jsx'
import { visiblePending } from '../utils/optimisticMessages.js'
import useTimeline from '../hooks/useTimeline.js'
import { prepareChatImage, chatImageError, activeSendStates } from '../utils/chatImage.js'

export default function ChatPanel({ user, selectedUser, initialConversation, onConversationOpened, onMessageSent, onMessageMutated, subscribeToMutations, subscribeToSync, token, onUnauthorized, subscribeToMessages, subscribeToTyping, sendTyping, isOnline, onBack, onProfile, optimistic, lastSeen, now, active = true }) {
  const [retryAttempt, setRetryAttempt] = useState(0)
  const [content, setContent] = useState('')
  const [draftId, setDraftId] = useState(null)
  const draft = optimistic.entries.find(entry => entry.localId === draftId)
  const sending = activeSendStates.has(draft?.state)
  useEffect(() => {
    if (draftId && (!draft || draft.state === 'sent' || draft.state === 'cancelled')) { setDraftId(null); setContent(''); setSelectedImage(null); setReplyTarget(null) }
  }, [draftId, draft])
  function detachDraft() {
    if (draft?.state === 'failed') optimistic.dismiss(draftId)
    setDraftId(null)
  }
  const [sendError, setSendError] = useState('')
  const [selectedImage, setSelectedImage] = useState(null)
  const [preparingImage, setPreparingImage] = useState(false)
  const selection = useRef(null)
  const submitLock = useRef(false)
  useEffect(() => () => { selection.current?.abort(); selection.current = null }, [])
  useEffect(() => { if (!sending) submitLock.current = false }, [sending, draft])
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
  const reactionRequests = useRef(new Set())
  const [replyTarget, setReplyTarget] = useState(null)
  const [photo, setPhoto] = useState(null)
  const closePhoto = useCallback(() => setPhoto(null), [])

  function replyName(preview) {
    return preview.sender_id === user.id ? 'You' : selectedUser.username
  }

  async function chooseImage(file, onRead) {
    if (!file) return
    selection.current?.abort()
    const controller = new AbortController()
    selection.current = controller
    detachDraft()
    setSelectedImage(null)
    setPreparingImage(true)
    setSendError('')
    try {
      const image = await prepareChatImage(file, { signal: controller.signal, onRead })
      if (!controller.signal.aborted) setSelectedImage(image)
    } catch (error) {
      if (!controller.signal.aborted) setSendError(chatImageError(error))
    } finally {
      if (selection.current === controller) { selection.current = null; setPreparingImage(false); onRead?.() }
    }
  }

  function removeImage() {
    selection.current?.abort(); selection.current = null
    setPreparingImage(false); detachDraft(); setSelectedImage(null); setSendError('')
  }

  const isActive = useRef(active)
  isActive.current = active
  const atBottom = useRef(true)
  const scrollAnchor = useRef(null)
  const navigationTimer = useRef(null)
  const positioned = useRef(false)
  const rememberedScrollTop = useRef(0)
  const [enterIds, setEnterIds] = useState(new Set())
  const knownIds = useRef(new Set())
  const animationTimers = useRef(new Set())
  const [highlightId, setHighlightId] = useState(null)
  const captureScroll = useCallback((reason) => {
    const element = history.current
    if (!element || !isActive.current) return null
    const rect = element.getBoundingClientRect()
    const visible = [...element.querySelectorAll('[data-message-id]')].filter(row => row.getBoundingClientRect().bottom > rect.top)
    const anchors = visible.slice(0, 3).map(row => ({ id: Number(row.dataset.messageId), top: row.getBoundingClientRect().top - rect.top }))
    scrollAnchor.current = { anchors, scrollTop: element.scrollTop, bottom: ['latest', 'reset'].includes(reason) || (atBottom.current && !['older', 'newer', 'context'].includes(reason)) }
    return anchors[0]
  }, [])
  const reconcileComposer = useCallback((items, missing) => {
    optimistic.reconcile(items, missing)
    setReplyTarget(current => {
      if (!current || missing.includes(current.id)) return null
      const updated = items.find(message => message.id === current.id)
      if (!updated) return current
      const preview = replyPreview(updated)
      return preview.content === current.content && preview.attachment_kind === current.attachment_kind ? current : preview
    })
    setEditingId(current => missing.includes(current) ? null : current)
  }, [optimistic.reconcile])
  const timeline = useTimeline({ token, selectedUser, initialConversation, onConversationOpened,
    onUnauthorized, subscribeToSync, beforeChange: captureScroll, atBottom,
    visible: active, onPersistedRead: onMessageSent, retryAttempt, onReconciled: reconcileComposer,
    trackedIds: [replyTarget?.id, editingId, ...optimistic.entries.filter(entry => entry.peer_id === selectedUser.id).map(entry => entry.serverId)].filter(id => id != null) })
  const { messages, conversation, stage, loadError } = timeline
  useEffect(() => {
    for (const message of messages) knownIds.current.add(message.id)
    while (knownIds.current.size > 400) knownIds.current.delete(knownIds.current.values().next().value)
  }, [messages])
  useEffect(() => subscribeToMessages(message => {
    if (message.sender_id === user.id || message.conversation_id !== conversationId.current || knownIds.current.has(message.id) || !atBottom.current || !isActive.current || document.visibilityState !== 'visible') return
    knownIds.current.add(message.id)
    setEnterIds(previous => new Set(previous).add(message.id))
    const timer = setTimeout(() => { setEnterIds(previous => { const next = new Set(previous); next.delete(message.id); return next }); animationTimers.current.delete(timer) }, 1500)
    animationTimers.current.add(timer)
  }), [subscribeToMessages, user.id])
  const pendingMessages = visiblePending(optimistic.entries, messages, conversation?.id)
  useEffect(() => optimistic.reconcile(messages), [messages, optimistic.reconcile])
  useEffect(() => { if (photo && !messages.some(message => message.attachment?.id === photo.id)) closePhoto() }, [messages, photo, closePhoto])
  const actions = useMessageActions(messages, history)
  conversationId.current = conversation?.id || null

  useLayoutEffect(() => {
    const element = history.current
    if (!element || !active) return
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
    } else if ((!anchor && (!positioned.current || atBottom.current)) || anchor?.bottom) element.scrollTop = element.scrollHeight
    else if (anchor) {
      const rect = element.getBoundingClientRect()
      const candidate = anchor.anchors.find(item => element.querySelector(`[data-message-id="${item.id}"]`))
      const row = candidate && element.querySelector(`[data-message-id="${candidate.id}"]`)
      if (row) element.scrollTop += row.getBoundingClientRect().top - rect.top - candidate.top
      else element.scrollTop = anchor.scrollTop
    }
    else if (!atBottom.current) element.scrollTop = rememberedScrollTop.current
    rememberedScrollTop.current = element.scrollTop
    positioned.current = true
    scrollAnchor.current = null
    atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 64 && !timeline.hasNewer
  }, [messages, stage, timeline.navigationId, optimistic.entries, active])

  useEffect(() => {
    // Heights can change after image decoding, reaction updates, or a resize.
    const element = history.current
    if (!element || stage !== 'ready' || !active) return
    const observer = new ResizeObserver(() => { if (isActive.current && atBottom.current) element.scrollTop = element.scrollHeight })
    const list = element.querySelector('ol')
    if (list) observer.observe(list)
    observer.observe(element)
    return () => observer.disconnect()
  }, [stage, active, Boolean(messages.length || pendingMessages.length)])

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

  useEffect(() => {
    if (!active) { stopTyping(); actions.close(); closePhoto() }
    timeline.retrySync()
  }, [active, stopTyping, actions.close, closePhoto])

  function handleContentChange(value) {
    if (value !== content) detachDraft()
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
    actionController.current?.abort()
    for (const request of reactionRequests.current) request.abort()
    for (const timer of animationTimers.current) clearTimeout(timer)
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
          setEditingId(null); setActionError('')
        }
      }
    } catch (error) {
      if (controller.signal.aborted || error.name === 'AbortError') return
      if (error.status === 401) onUnauthorized()
      else { if (deleting) throw error; setActionError(error.displayMessage || 'Unable to edit your message. Please try again.') }
    } finally {
      actionPending.current = false
      if (!controller.signal.aborted) setActionBusy(false)
    }
  }

  function handleSend(event) {
    event.preventDefault()
    if (sending || preparingImage || submitLock.current || stage !== 'ready' || !conversation) return
    if (draft?.state === 'failed') { optimistic.retry(draftId); stopTyping(); return }
    const trimmed = content.trim()
    if (!trimmed && !selectedImage) return
    if (Array.from(trimmed).length > 2000) { setSendError('Use a message between 1 and 2000 characters.'); return }
    try {
      captureScroll('pending')
      submitLock.current = true
      const dimensions = selectedImage ? { width: selectedImage.width, height: selectedImage.height } : null
      const id = optimistic.enqueue({ peer_id: selectedUser.id, conversation_id: conversation.id, content: trimmed, file: selectedImage?.blob || null, filename: selectedImage?.name, dimensions, reply_to: replyTarget })
      stopTyping()
      setDraftId(id); setSendError('')
    } catch (error) { submitLock.current = false; setSendError(error.message) }
  }

  return (
    <section aria-labelledby="chat-title" className="chat-panel">
      <ChatHeader lastSeen={lastSeen} now={now} selectedUser={selectedUser} isOnline={isOnline} otherTyping={otherTyping} onBack={onBack} onProfile={onProfile} />
      {stage === 'opening' || stage === 'loading' ? (
        <p role="status" className="chat-loading"><span className="loading-spinner" aria-hidden="true" />{stage === 'opening' ? 'Opening conversation…' : 'Loading messages…'}</p>
      ) : stage === 'error' ? (
        <div className="chat-load-error">
          <p role="alert" className="form-error">{loadError}</p>
          <button type="button" className="secondary-button" onClick={() => setRetryAttempt((attempt) => attempt + 1)}>Try again</button>
        </div>
      ) : (
        <>
          <div className="timeline-toolbar">
            {timeline.hasOlder && <button type="button" className="text-button min-h-9 text-sm" disabled={timeline.busy} onClick={timeline.loadOlder}>Load older messages</button>}
            {timeline.busy && <span role="status" className="sr-only">Updating messages...</span>}
          </div>
          {timeline.syncError && <p role="alert" className="timeline-error">{timeline.syncError} <button type="button" className="text-button" onClick={timeline.retrySync}>Retry messages</button></p>}
          <div ref={history} tabIndex={0} onScroll={() => {
            const element = history.current
            if (!isActive.current) return
            rememberedScrollTop.current = element.scrollTop
            atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 64 && !timeline.hasNewer
            if (atBottom.current) timeline.clearNew()
          }} role="log" aria-label="Message history" className="chat-history">
            {messages.length === 0 && pendingMessages.length === 0 ? (
              <EmptyState compact title="A fresh conversation.">Send a hello to get started.</EmptyState>
            ) : (
              <MessageList actionId={actions.target?.id} reactionRequests={reactionRequests.current} enterIds={enterIds} pending={pendingMessages} onRetry={optimistic.retry} onDismiss={optimistic.dismiss} onCancel={optimistic.cancel} messages={messages} user={user} selectedUser={selectedUser} timeline={timeline} highlightId={highlightId} token={token} onUnauthorized={onUnauthorized} onOpen={actions.open} onPhoto={setPhoto} />
            )}
          </div>
          <div className="timeline-navigation"><div>
            {timeline.hasNewer && <button type="button" className="text-button min-h-9 text-sm" disabled={timeline.busy} onClick={timeline.loadNewer}>Load newer messages</button>}
            {(timeline.newCount > 0 || timeline.hasNewer) && <button type="button" className="jump-latest" disabled={timeline.busy} onClick={timeline.jumpLatest}><Icon name="down" size={16} />{timeline.newCount > 0 ? `${timeline.newCount} new ${timeline.newCount === 1 ? 'message' : 'messages'} · ` : ''}Jump to latest</button>}
          </div></div>
          <ChatComposer editing={editingId !== null} onCancelEdit={() => { setEditingId(null); setActionError('') }} content={editingId !== null ? editContent : content} onChange={editingId !== null ? setEditContent : handleContentChange} onSubmit={editingId !== null ? event => performAction(messages.find(message => message.id === editingId) || { id: editingId }, false, event) : handleSend} sending={sending || actionBusy} error={editingId !== null ? actionError : sendError} image={selectedImage} preparingImage={preparingImage} onPreviewError={() => { setSelectedImage(null); setSendError('Unable to display this photo. Please select it again.') }} onImage={chooseImage} onRemoveImage={removeImage} replyTarget={replyTarget} replyName={replyName} replyText={replyText} onCancelReply={() => { detachDraft(); setReplyTarget(null) }} />
        </>
      )}
      {actions.target && messages.some(message => message.id === actions.target.id) && <MessageActionMenu reactionRequests={reactionRequests.current} target={actions.target} message={messages.find(message => message.id === actions.target.id)} own={messages.find(message => message.id === actions.target.id).sender_id === user.id} onClose={actions.close} token={token} onUnauthorized={onUnauthorized} onChanged={timeline.retrySync} onReply={message => { detachDraft(); setEditingId(null); setReplyTarget(replyPreview(message)); requestAnimationFrame(() => document.getElementById('message-content')?.focus()) }} onEdit={message => { detachDraft(); stopTyping(); setEditingId(message.id); setEditContent(message.content); setActionError(''); requestAnimationFrame(() => document.getElementById('message-content')?.focus()) }} onDelete={message => performAction(message, true)} />}
      {photo && <ImageViewer attachment={photo} token={token} onUnauthorized={onUnauthorized} onClose={closePhoto} />}
    </section>
  )
}
