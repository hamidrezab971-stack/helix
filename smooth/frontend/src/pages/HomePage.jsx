import { useCallback, useEffect, useRef, useState } from 'react'
import ChatPanel from '../components/ChatPanel.jsx'
import { getUsers, getConversations } from '../services/api.js'
import { connectRealtime } from '../services/realtime.js'

function newerMessage(incoming, current) {
  return incoming && (!current || Date.parse(incoming.created_at) > Date.parse(current.created_at)
    || (Date.parse(incoming.created_at) === Date.parse(current.created_at) && incoming.id > current.id))
}

function sortRecent(conversations) {
  return [...conversations].sort((a, b) => {
    if (!a.last_message || !b.last_message) return Number(Boolean(b.last_message)) - Number(Boolean(a.last_message)) || b.id - a.id
    return Date.parse(b.last_message.created_at) - Date.parse(a.last_message.created_at) || b.last_message.id - a.last_message.id || b.id - a.id
  }).slice(0, 50)
}

function recentTime(timestamp) {
  // SQLite stores UTC datetimes without an offset; format in the viewer's zone.
  const date = new Date(/(Z|[+-]\d\d:\d\d)$/.test(timestamp) ? timestamp : `${timestamp}Z`)
  const today = new Date()
  return new Intl.DateTimeFormat(undefined, date.toDateString() === today.toDateString()
    ? { hour: '2-digit', minute: '2-digit' } : { month: 'short', day: 'numeric' }).format(date)
}

function previewText(message) {
  const text = message.content.replace(/\s+/g, ' ')
  return message.attachment ? `Photo${text ? ` · ${text}` : ''}` : text
}

export default function HomePage({ user, token, error, onLogout, onUnauthorized }) {
  const [search, setSearch] = useState('')
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [retryAttempt, setRetryAttempt] = useState(0)
  const [selectedUser, setSelectedUser] = useState(null)
  const [selectedConversation, setSelectedConversation] = useState(null)
  const [recent, setRecent] = useState([])
  const [recentLoading, setRecentLoading] = useState(true)
  const [recentError, setRecentError] = useState('')
  const [conversationAttempt, setConversationAttempt] = useState(0)
  const [onlineUserIds, setOnlineUserIds] = useState(new Set())
  const [pageVisible, setPageVisible] = useState(document.visibilityState === 'visible')
  const normalizedSearch = search.trim().toLowerCase()
  const messageListeners = useRef(new Set())
  const mutationListeners = useRef(new Set())
  const typingListeners = useRef(new Set())
  const statusListeners = useRef(new Set())
  const realtime = useRef(null)
  const recentController = useRef(null)
  const activeConversationId = useRef(null)
  const receivedMessageIds = useRef(new Set())
  const deletedMessageIds = useRef(new Set())

  const refreshRecent = useCallback(async () => {
    recentController.current?.abort()
    const controller = new AbortController()
    recentController.current = controller
    setRecentLoading(true)
    setRecentError('')
    try {
      const loaded = await getConversations(token, controller.signal)
      if (controller.signal.aborted) return
      setRecent((previous) => sortRecent(loaded.map((conversation) => {
        const current = previous.find((item) => item.id === conversation.id)
        // Preserve a newer WebSocket preview received during this HTTP request.
        return newerMessage(current?.last_message, conversation.last_message)
          ? { ...conversation, last_message: current.last_message, updated_at: current.updated_at } : conversation
      })))
    } catch (error) {
      if (controller.signal.aborted || error.name === 'AbortError') return
      if (error.status === 401) onUnauthorized()
      else setRecentError('Unable to load conversations.')
    } finally {
      if (!controller.signal.aborted) setRecentLoading(false)
    }
  }, [token, onUnauthorized])

  useEffect(() => {
    refreshRecent()
    return () => recentController.current?.abort()
  }, [refreshRecent])

  useEffect(() => {
    function visibilityChanged() {
      setPageVisible(document.visibilityState === 'visible')
      if (document.visibilityState === 'visible') refreshRecent()
    }
    document.addEventListener('visibilitychange', visibilityChanged)
    return () => document.removeEventListener('visibilitychange', visibilityChanged)
  }, [refreshRecent])

  const updateRecentMessage = useCallback((message) => {
    const firstDelivery = !receivedMessageIds.current.has(message.id)
    receivedMessageIds.current.add(message.id)
    const willRead = activeConversationId.current === message.conversation_id && document.visibilityState === 'visible'
    setRecent((previous) => sortRecent(previous.map((conversation) => {
      if (conversation.id !== message.conversation_id) return conversation
      // IDs at/below the HTTP snapshot's latest message are already included
      // in its count. Replayed socket events must not count them twice.
      const increment = firstDelivery && message.sender_id !== user.id && !willRead
        && (!conversation.last_message || message.id > conversation.last_message.id)
      const latest = newerMessage(message, conversation.last_message)
      return { ...conversation, unread_count: conversation.unread_count + (increment ? 1 : 0),
        ...(latest ? { last_message: { id: message.id, sender_id: message.sender_id, content: message.content, created_at: message.created_at, attachment: message.attachment }, updated_at: message.created_at } : {}) }
    })))
    refreshRecent()
  }, [refreshRecent, user.id])

  const onConversationOpened = useCallback((conversation) => {
    activeConversationId.current = conversation.id
    refreshRecent()
  }, [refreshRecent])

  const subscribeToMutations = useCallback((listener) => {
    mutationListeners.current.add(listener)
    return () => mutationListeners.current.delete(listener)
  }, [])

  const handleMutation = useCallback((event) => {
    if (event.type === 'message:updated' && deletedMessageIds.current.has(event.data.id)) return
    if (event.type === 'message:deleted') {
      deletedMessageIds.current.add(event.data.message_id)
      receivedMessageIds.current.delete(event.data.message_id)
      realtime.current?.forgetMessage(event.data.message_id)
    }
    for (const listener of mutationListeners.current) listener(event)
    setRecent((previous) => previous.map((conversation) => {
      if (conversation.id !== event.data.conversation_id) return conversation
      if (event.type === 'message:deleted' && conversation.last_message?.id === event.data.message_id) {
        // Remove the cached latest preview before fetching its fallback;
        // otherwise the old "preserve newer preview" rule would restore it.
        return { ...conversation, last_message: null }
      }
      if (event.type === 'message:updated' && conversation.last_message?.id === event.data.id) {
        return { ...conversation, last_message: { ...conversation.last_message, content: event.data.content } }
      }
      return conversation
    }))
    refreshRecent()
  }, [refreshRecent])

  const subscribeToStatus = useCallback((listener) => {
    statusListeners.current.add(listener)
    return () => statusListeners.current.delete(listener)
  }, [])
  const acknowledge = useCallback((type, messageId) => {
    realtime.current?.acknowledge(type, messageId)
  }, [])

  const subscribeToTyping = useCallback((listener) => {
    typingListeners.current.add(listener)
    return () => typingListeners.current.delete(listener)
  }, [])

  const sendTyping = useCallback((type, conversationId) => (
    realtime.current?.sendTyping(type, conversationId) || false
  ), [])

  const subscribeToMessages = useCallback((listener) => {
    messageListeners.current.add(listener)
    return () => messageListeners.current.delete(listener)
  }, [])

  useEffect(() => {
    if (!token) return
    const connection = connectRealtime(token, {
      onMutation: handleMutation,
      onMessage: (message) => {
        if (deletedMessageIds.current.has(message.id)) return
        for (const listener of messageListeners.current) listener(message)
        if (message.sender_id !== user.id) acknowledge('message:delivered', message.id)
        updateRecentMessage(message)
      },
      onStatus: (status) => {
        for (const listener of statusListeners.current) listener(status)
        if (status.read_at) refreshRecent()
      },
      onPresenceSnapshot: (ids) => {
        setOnlineUserIds(new Set(ids))
        refreshRecent()
      },
      onPresenceUpdate: ({ user_id, status }) => setOnlineUserIds((previous) => {
        const next = new Set(previous)
        if (status === 'online') next.add(user_id)
        else next.delete(user_id)
        return next
      }),
      onTyping: (event) => {
        for (const listener of typingListeners.current) listener(event)
      },
      onDisconnect: () => {
        setOnlineUserIds(new Set())
        for (const listener of typingListeners.current) listener(null)
      },
      onUnauthorized,
    })
    realtime.current = connection
    return () => {
      connection.stop()
      realtime.current = null
    }
  }, [token, onUnauthorized, user.id, acknowledge, updateRecentMessage, refreshRecent, handleMutation])

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    setLoading(true)
    setLoadError('')
    setUsers([])

    async function loadUsers() {
      try {
        const directory = await getUsers(token, normalizedSearch, controller.signal)
        if (active) setUsers(directory)
      } catch (error) {
        if (!active || error.name === 'AbortError') return
        if (error.status === 401) {
          onUnauthorized()
        } else {
          setLoadError('Unable to load users.')
        }
      } finally {
        if (active) setLoading(false)
      }
    }

    const timeout = setTimeout(loadUsers, normalizedSearch ? 300 : 0)
    return () => {
      active = false
      clearTimeout(timeout)
      controller.abort()
    }
  }, [token, normalizedSearch, retryAttempt, onUnauthorized])

  return (
    <section aria-labelledby="directory-title" className="w-full max-w-5xl overflow-hidden rounded-3xl border border-stone-200/80 bg-white shadow-[0_16px_64px_-32px_rgba(56,40,25,0.2)]">
      <header className="flex flex-col gap-5 border-b border-stone-200/80 p-6 sm:flex-row sm:items-center sm:justify-between sm:p-8">
        <div className="min-w-0">
          <h1 id="directory-title" className="text-2xl font-semibold tracking-tight text-stone-900">Your conversations.</h1>
          <p className="mt-2 text-sm text-stone-500">Recent chats and people.</p>
        </div>
        <div className="flex min-w-0 items-center justify-between gap-4">
          <span className="min-w-0 break-all text-sm font-medium text-stone-700">@{user.username}</span>
          <button type="button" className="secondary-button shrink-0" onClick={onLogout}>Log out</button>
        </div>
      </header>
      {error && <p role="alert" className="form-error m-6">{error}</p>}
      <div className="grid md:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
        <div className={`min-w-0 p-6 sm:p-8 ${selectedUser ? 'hidden md:block' : 'block'}`}>
          <section aria-labelledby="recent-title" className="mb-8">
            <h2 id="recent-title" className="text-sm font-semibold text-stone-800">Chats</h2>
            {recentError && <div className="mt-3 space-y-3">
              <p role="alert" className="form-error">{recentError}</p>
              <button type="button" className="secondary-button" onClick={refreshRecent}>Retry conversations</button>
            </div>}
            {recentLoading && recent.length === 0 ? <p role="status" className="mt-3 text-sm text-stone-500">Loading conversations...</p>
              : !recentError && recent.length === 0 ? <p className="mt-3 text-sm leading-6 text-stone-500">No conversations yet.<br />Find someone to start chatting.</p>
              : <ul aria-label="Recent conversations" className="mt-3 space-y-2">
                {recent.map((conversation) => (
                  <li key={conversation.id}>
                    <button type="button" className="recent-row" aria-pressed={selectedUser?.id === conversation.other_user.id}
                      onClick={() => {
                        setSelectedUser(conversation.other_user)
                        setSelectedConversation(conversation)
                        activeConversationId.current = conversation.id
                        setConversationAttempt((attempt) => attempt + 1)
                      }}>
                      <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                        <span className="flex min-w-0 items-center justify-between gap-2">
                          <span className="truncate font-medium">@{conversation.other_user.username}</span>
                          {conversation.last_message && <time className="shrink-0 text-[11px] text-stone-500" dateTime={conversation.last_message.created_at} title={conversation.last_message.created_at}>{recentTime(conversation.last_message.created_at)}</time>}
                        </span>
                        <span className="block truncate text-xs text-stone-500" aria-label="Last message preview">
                          {conversation.last_message ? `${conversation.last_message.sender_id === user.id ? 'You: ' : ''}${previewText(conversation.last_message)}` : 'No messages yet.'}
                        </span>
                        <span className="flex items-center justify-between gap-2">
                          <span className={`text-[11px] ${onlineUserIds.has(conversation.other_user.id) ? 'text-emerald-700' : 'text-stone-500'}`}>
                            {onlineUserIds.has(conversation.other_user.id) ? 'Online' : 'Offline'}
                          </span>
                          {conversation.unread_count > 0 && !(selectedUser?.id === conversation.other_user.id && pageVisible) && (
                            <span aria-label={`${conversation.unread_count} unread ${conversation.unread_count === 1 ? 'message' : 'messages'}`} className="inline-flex min-w-5 shrink-0 items-center justify-center rounded-full bg-[#b65339] px-1.5 py-0.5 text-[11px] font-semibold text-white">
                              {conversation.unread_count > 99 ? '99+' : conversation.unread_count}
                            </span>
                          )}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>}
          </section>
        <section aria-label="User directory">
          <h2 className="mb-3 text-sm font-semibold text-stone-800">People</h2>
          <label htmlFor="user-search" className="text-sm font-medium text-stone-800">Search by username</label>
          <input
            id="user-search" type="search" className="auth-input" placeholder="Search users..."
            autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false}
            value={search} onChange={(event) => setSearch(event.target.value)}
          />
          <div className="mt-6 min-h-48" aria-busy={loading}>
            {loading ? (
              <p role="status" className="py-6 text-sm text-stone-500">Loading users...</p>
            ) : loadError ? (
              <div className="space-y-4 py-6">
                <p role="alert" className="form-error">{loadError}</p>
                <button type="button" className="secondary-button" onClick={() => setRetryAttempt((attempt) => attempt + 1)}>Try again</button>
              </div>
            ) : users.length === 0 ? (
              <p role="status" className="py-6 text-sm text-stone-500">{normalizedSearch ? 'No users found.' : 'No users yet.'}</p>
            ) : (
              <ul className="space-y-2">
                {users.map((directoryUser) => (
                  <li key={directoryUser.id}>
                    <button
                      type="button" className="user-row"
                      aria-pressed={selectedUser?.id === directoryUser.id}
                      onClick={() => {
                        setSelectedUser(directoryUser)
                        setSelectedConversation(null)
                        activeConversationId.current = null
                        setConversationAttempt((attempt) => attempt + 1)
                      }}
                    >
                      <span className="min-w-0 break-all font-medium">@{directoryUser.username}</span>
                      <span className={`flex shrink-0 items-center gap-1.5 text-xs ${onlineUserIds.has(directoryUser.id) ? 'text-emerald-700' : 'text-stone-500'}`}>
                        <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${onlineUserIds.has(directoryUser.id) ? 'bg-emerald-600' : 'bg-stone-300'}`} />
                        {onlineUserIds.has(directoryUser.id) ? 'Online' : 'Offline'}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
        </div>
        <aside aria-label="Conversation" className={`min-w-0 border-t border-stone-200/80 bg-[#fcfbf9] md:border-t-0 md:border-l ${selectedUser ? 'block' : 'hidden md:block'}`}>
          {selectedUser ? (
            <>
              <button type="button" className="secondary-button mx-6 mt-5 md:hidden" onClick={() => { setSelectedUser(null); setSelectedConversation(null); activeConversationId.current = null }}>Back to chats</button>
              <ChatPanel key={`${selectedUser.id}:${conversationAttempt}`} user={user} selectedUser={selectedUser} initialConversation={selectedConversation} onConversationOpened={onConversationOpened} onMessageSent={updateRecentMessage} onMessageMutated={handleMutation} subscribeToMutations={subscribeToMutations} token={token} onUnauthorized={onUnauthorized} subscribeToMessages={subscribeToMessages} subscribeToStatus={subscribeToStatus} acknowledge={acknowledge} subscribeToTyping={subscribeToTyping} sendTyping={sendTyping} isOnline={onlineUserIds.has(selectedUser.id)} />
            </>
          ) : (
            <div className="flex h-full flex-col justify-center p-6 sm:p-8">
              <p className="text-xs font-semibold uppercase tracking-widest text-stone-500">A little more connection</p>
              <p className="mt-3 text-2xl font-semibold tracking-tight text-stone-900">Select a user.</p>
              <p className="mt-3 text-sm leading-6 text-stone-500">Choose someone from the directory to open a conversation.</p>
            </div>
          )}
        </aside>
      </div>
    </section>
  )
}
