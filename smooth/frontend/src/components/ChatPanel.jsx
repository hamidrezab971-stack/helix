import { useEffect, useRef, useState } from 'react'
import { getMessages, getOrCreateConversation, sendMessage } from '../services/api.js'

export default function ChatPanel({ user, selectedUser, token, onUnauthorized }) {
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

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    setStage('opening')
    setLoadError('')
    setConversation(null)
    setMessages([])

    async function openConversation() {
      let fallback = 'Unable to open this conversation. Please try again.'
      try {
        const resolved = await getOrCreateConversation(token, selectedUser.id, controller.signal)
        if (!active) return
        setConversation(resolved)
        setStage('loading')
        fallback = 'Unable to load messages. Please try again.'
        const loaded = await getMessages(token, resolved.id, controller.signal)
        if (!active) return
        setMessages(loaded)
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
  }, [token, selectedUser.id, retryAttempt, onUnauthorized])

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
      setMessages((previous) => [...previous, message])
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
        <p className="mt-1 text-xs text-stone-500">Updates when you open this conversation or send a message.</p>
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
              onChange={(event) => setContent(event.target.value)}
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
