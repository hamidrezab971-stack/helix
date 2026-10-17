import { useCallback, useEffect, useRef, useState } from 'react'
import useChatViewport from '../hooks/useChatViewport.js'
import useMediaQuery from '../hooks/useMediaQuery.js'
import usePresence from '../hooks/usePresence.js'
import PresenceLabel from '../components/chat/PresenceLabel.jsx'
import useOptimisticMessages from '../hooks/useOptimisticMessages.js'
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
  useChatViewport()
  const desktop = useMediaQuery('(min-width: 768px)')
  const [showList, setShowList] = useState(true)
  const chatVisible = desktop || !showList
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
  const presence = usePresence(token, onUnauthorized)
  const onlineUserIds = presence.onlineIds
  const [pageVisible, setPageVisible] = useState(document.visibilityState === 'visible')
  const normalizedSearch = search.trim().toLowerCase()
  const messageListeners = useRef(new Set())
  const syncListeners = useRef(new Set())
  const mutationListeners = useRef(new Set())
  const typingListeners = useRef(new Set())
  const statusListeners = useRef(new Set())
  const realtime = useRef(null)
  const recentController = useRef(null)
  const activeConversationId = useRef(null)
  const recentTimer = useRef(null)

  const refreshRecent = useCallback(async () => {
    recentController.current?.abort()
    const controller = new AbortController()
    recentController.current = controller
    setRecentLoading(true)
    setRecentError('')
    try {
      const loaded = await getConversations(token, controller.signal)
      if (controller.signal.aborted) return
      setRecent(sortRecent(loaded))
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

  const queueRecent = useCallback(() => {
    clearTimeout(recentTimer.current)
    recentTimer.current = setTimeout(refreshRecent, 80)
  }, [refreshRecent])

  const wakeTimeline = useCallback((id) => {
    for (const listener of syncListeners.current) listener(id)
    queueRecent()
  }, [queueRecent])

  const subscribeToSync = useCallback((listener) => {
    syncListeners.current.add(listener)
    return () => syncListeners.current.delete(listener)
  }, [])

  const updateRecentMessage = useCallback(() => wakeTimeline(), [wakeTimeline])

  const onConversationOpened = useCallback((conversation) => {
    activeConversationId.current = conversation.id
    presence.refresh()
    refreshRecent()
  }, [refreshRecent, presence.refresh])

  const subscribeToMutations = useCallback((listener) => {
    mutationListeners.current.add(listener)
    return () => mutationListeners.current.delete(listener)
  }, [])

  const handleMutation = useCallback((event) => {
    for (const listener of mutationListeners.current) listener(event)
    wakeTimeline(event.data.conversation_id)
  }, [wakeTimeline])

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

  const optimistic = useOptimisticMessages({ token, userId: user.id, onUnauthorized, onChanged: updateRecentMessage, subscribeToMessages })


  useEffect(() => {
    if (!token) return
    const connection = connectRealtime(token, {
      onWake: wakeTimeline,
      onReactions: () => {},
      onMutation: handleMutation,
      onMessage: (message) => {
        for (const listener of messageListeners.current) listener(message)
        if (message.sender_id !== user.id) acknowledge('message:delivered', message.id)
        updateRecentMessage(message)
      },
      onStatus: (status) => {
        for (const listener of statusListeners.current) listener(status)
        if (status.read_at) refreshRecent()
      },
      onPresenceSnapshot: (ids) => { presence.snapshot(ids); refreshRecent() },
      onPresenceUpdate: presence.update,
      onTyping: (event) => {
        for (const listener of typingListeners.current) listener(event)
      },
      onDisconnect: () => {
        presence.disconnect()
        for (const listener of typingListeners.current) listener(null)
      },
      onUnauthorized,
    })
    realtime.current = connection
    return () => {
      connection.stop()
      clearTimeout(recentTimer.current)
      realtime.current = null
    }
  }, [token, onUnauthorized, user.id, acknowledge, updateRecentMessage, refreshRecent, handleMutation, wakeTimeline, presence.snapshot, presence.update, presence.disconnect])

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
    <section aria-labelledby="directory-title" className="chat-shell" data-chat-open={selectedUser && !showList ? true : false}>
      <div className="chat-sidebar">
      <header className="sidebar-header">
        <div className="min-w-0">
          <h1 id="directory-title" className="text-2xl font-semibold tracking-tight text-stone-900">Your conversations.</h1>
          <p className="mt-2 text-sm text-stone-500">Recent chats and people.</p>
        </div>
        <div className="flex min-w-0 items-center justify-between gap-4">
          <span className="min-w-0 break-all text-sm font-medium text-stone-700">@{user.username}</span>
          <button type="button" className="secondary-button shrink-0" onClick={onLogout}>Log out</button>
        </div>
      </header>
      {error && <p role="alert" className="form-error m-3">{error}</p>}
      <div className="sidebar-content">
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
                        setShowList(false)
                        if (!desktop && showList && selectedUser?.id === conversation.other_user.id) return
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
                            <PresenceLabel online={onlineUserIds.has(conversation.other_user.id)} lastSeen={presence.lastSeen.get(conversation.other_user.id)} now={presence.now} />
                          </span>
                          {conversation.unread_count > 0 && !(selectedUser?.id === conversation.other_user.id && pageVisible && chatVisible) && (
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
                        setShowList(false)
                        if (!desktop && showList && selectedUser?.id === directoryUser.id) return
                        setSelectedUser(directoryUser)
                        setSelectedConversation(null)
                        activeConversationId.current = null
                        setConversationAttempt((attempt) => attempt + 1)
                      }}
                    >
                      <span className="min-w-0 break-all font-medium">@{directoryUser.username}</span>
                      <span className={`flex shrink-0 items-center gap-1.5 text-xs ${onlineUserIds.has(directoryUser.id) ? 'text-emerald-700' : 'text-stone-500'}`}>
                        <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${onlineUserIds.has(directoryUser.id) ? 'bg-emerald-600' : 'bg-stone-300'}`} />
                        {onlineUserIds.has(directoryUser.id) ? 'online' : 'offline'}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
        </div>
        </div>
        <aside aria-label="Conversation" className="conversation-pane">
          {selectedUser ? (
            <>

              <ChatPanel active={chatVisible} lastSeen={presence.lastSeen.get(selectedUser.id)} now={presence.now} optimistic={optimistic} onBack={() => setShowList(true)} key={`${selectedUser.id}:${conversationAttempt}`} user={user} selectedUser={selectedUser} initialConversation={selectedConversation} onConversationOpened={onConversationOpened} onMessageSent={updateRecentMessage} onMessageMutated={handleMutation} subscribeToMutations={subscribeToMutations} subscribeToSync={subscribeToSync} token={token} onUnauthorized={onUnauthorized} subscribeToMessages={subscribeToMessages} subscribeToStatus={subscribeToStatus} acknowledge={acknowledge} subscribeToTyping={subscribeToTyping} sendTyping={sendTyping} isOnline={onlineUserIds.has(selectedUser.id)} />
            </>
          ) : (
            <div className="flex h-full flex-col justify-center p-6 sm:p-8">
              <p className="text-xs font-semibold uppercase tracking-widest text-stone-500">A little more connection</p>
              <p className="mt-3 text-2xl font-semibold tracking-tight text-stone-900">Select a user.</p>
              <p className="mt-3 text-sm leading-6 text-stone-500">Choose someone from the directory to open a conversation.</p>
            </div>
          )}
        </aside>
    </section>
  )
}
