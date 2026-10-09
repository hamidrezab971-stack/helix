import { useCallback, useEffect, useRef, useState } from 'react'
import { getMessages, getOrCreateConversation, sendMessage, mergeReceipt } from '../services/api.js'

function mergeMessages(current, incoming) {
  const messages = new Map(current.map((message) => [message.id, message]))
  for (const message of incoming) messages.set(message.id, { ...message, ...mergeReceipt(messages.get(message.id), message) })
  return [...messages.values()].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id - b.id)
}

export default function ChatPanel({ user, selectedUser, token, onUnauthorized, subscribeToMessages, subscribeToStatus, acknowledge, subscribeToTyping, sendTyping, isOnline }) {
  const [conversation, setConversation] = useState(null)
  const [messages, setMessages] = useState([])
  const [stage, setStage] = useState('opening')
  const [loadError, setLoadError] = useState('')
  const [retryAttempt, setRetryAttempt] = useState(0)
  const [content, setContent] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState('')
  const pending = useRef(false)
  const sendController = useRef(null)
  const history = useRef(null)
  const conversationId = useRef(null)
  const [otherTyping, setOtherTyping] = useState(false)
  const localTyping = useRef(false)
  const typingStartedAt = useRef(0)
  const typingTimer = useRef(null)
  const remoteTypingTimer = useRef(null)
  const receipts = useRef(new Map())

  const addMessages = useCallback((incoming) => {
    setMessages((previous) => mergeMessages(previous, incoming.map((message) => (
      { ...message, ...mergeReceipt(receipts.current.get(message.id), message) }
    ))))
  }, [])

  useEffect(() => subscribeToStatus((status) => {
    // A recipient can acknowledge before the sender's HTTP response arrives.
    const merged = mergeReceipt(receipts.current.get(status.message_id), status)
    receipts.current.set(status.message_id, merged)
    setMessages((previous) => previous.map((message) => message.id === status.message_id && message.sender_id === user.id
      ? { ...message, ...mergeReceipt(message, merged) } : message))
  }), [subscribeToStatus, user.id])

  useEffect(() => {
    function acknowledgeIncoming() {
      if (stage !== 'ready') return
      for (const message of messages) {
        if (message.sender_id === user.id) continue
        if (!message.delivered_at) acknowledge('message:delivered', message.id)
        if (!message.read_at && document.visibilityState === 'visible') acknowledge('message:read', message.id)
      }
    }
    acknowledgeIncoming()
    document.addEventListener('visibilitychange', acknowledgeIncoming)
    return () => document.removeEventListener('visibilitychange', acknowledgeIncoming)
  }, [messages, stage, user.id, acknowledge])

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

  useEffect(() => subscribeToMessages((message) => {
    if (message.conversation_id !== conversationId.current) return
    if (message.sender_id !== user.id && message.sender_id !== selectedUser.id) return
    addMessages([message])
  }), [subscribeToMessages, user.id, selectedUser.id, addMessages])

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    stopTyping()
    clearTimeout(remoteTypingTimer.current)
    setOtherTyping(false)
    setStage('opening')
    setLoadError('')
    setConversation(null)
    conversationId.current = null
    setMessages([])

    async function openConversation() {
      let fallback = 'Unable to open this conversation. Please try again.'
      try {
        const resolved = await getOrCreateConversation(token, selectedUser.id, controller.signal)
        if (!active) return
        conversationId.current = resolved.id
        setConversation(resolved)
        setStage('loading')
        fallback = 'Unable to load messages. Please try again.'
        const loaded = await getMessages(token, resolved.id, controller.signal)
        if (!active) return
        // Preserve events received while the HTTP history request was in flight.
        addMessages(loaded)
        setStage('ready')
      } catch (error) {
        if (!active || error.name === 'AbortError') return
        if (error.status === 401) {
          onUnauthorized()
        } else {
          setLoadError([403, 404].includes(error.status) ? error.displayMessage : fallback)
          setStage('error')
        }
      }
    }

    openConversation()
    return () => {
      active = false
      controller.abort()
      sendController.current?.abort()
    }
  }, [token, selectedUser.id, retryAttempt, onUnauthorized, stopTyping, addMessages])

  useEffect(() => {
    if (history.current) history.current.scrollTop = history.current.scrollHeight
  }, [messages])

  async function handleSend(event) {
    event.preventDefault()
    if (pending.current || stage !== 'ready' || !conversation) return
    const trimmed = content.trim()
    if (!trimmed) return
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
      const message = await sendMessage(token, conversation.id, trimmed, controller.signal)
      if (controller.signal.aborted) return
      stopTyping()
      addMessages([message])
      setContent('')
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
    <section aria-labelledby="chat-title" className="flex min-w-0 flex-col p-6 sm:p-8">
      <header className="border-b border-stone-200/80 pb-5">
        <h2 id="chat-title" className="break-all text-xl font-semibold tracking-tight text-stone-900">@{selectedUser.username}</h2>
        <p className={`mt-1 text-xs ${isOnline ? 'text-emerald-700' : 'text-stone-500'}`} aria-label="Contact presence">{isOnline ? 'Online' : 'Offline'}</p>
        <p role="status" aria-label="Typing indicator" className="mt-1 min-h-4 text-xs text-stone-500">{otherTyping ? `${selectedUser.username} is typing...` : ''}</p>
      </header>
      {stage === 'opening' || stage === 'loading' ? (
        <p role="status" className="min-h-64 py-8 text-sm text-stone-500">{stage === 'opening' ? 'Opening conversation...' : 'Loading messages...'}</p>
      ) : stage === 'error' ? (
        <div className="min-h-64 space-y-4 py-8">
          <p role="alert" className="form-error">{loadError}</p>
          <button type="button" className="secondary-button" onClick={() => setRetryAttempt((attempt) => attempt + 1)}>Try again</button>
        </div>
      ) : (
        <>
          <div ref={history} role="log" aria-label="Message history" className="chat-history">
            {messages.length === 0 ? (
              <p className="py-8 text-center text-sm leading-6 text-stone-500">No messages yet.<br />Start the conversation.</p>
            ) : (
              <ol className="space-y-3">
                {messages.map((message) => (
                  <li key={message.id} className={`flex ${message.sender_id === user.id ? 'justify-end' : 'justify-start'}`}>
                    <p className="message-bubble" data-own={message.sender_id === user.id}>
                      <span className="sr-only">{message.sender_id === user.id ? 'You' : selectedUser.username}: </span>
                      {message.content}
                      {message.sender_id === user.id && (
                        <span aria-label="Message status" className={`mt-1 block text-right text-[10px] ${message.read_at ? 'font-semibold' : 'opacity-75'}`}>
                          {message.read_at ? 'Read' : message.delivered_at ? 'Delivered' : 'Sent'}
                        </span>
                      )}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </div>
          <form onSubmit={handleSend} aria-busy={sending} className="border-t border-stone-200/80 pt-5">
            <label htmlFor="message-content" className="text-sm font-medium text-stone-800">Message</label>
            <textarea
              id="message-content" className="auth-input min-h-24 resize-y" rows={3}
              placeholder="Write a message..." maxLength={2000} disabled={sending}
              aria-describedby="message-hint" value={content}
              onChange={(event) => handleContentChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  event.currentTarget.form.requestSubmit()
                }
              }}
            />
            <p id="message-hint" className="mt-2 text-xs leading-5 text-stone-500">Up to 2000 characters. Enter to send; Shift+Enter for a new line.</p>
            {sendError && <p role="alert" className="form-error mt-3">{sendError}</p>}
            <button type="submit" className="primary-button mt-4 w-full" disabled={sending || !content.trim()}>{sending ? 'Sending...' : 'Send'}</button>
          </form>
        </>
      )}
    </section>
  )
}
