import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import useChatViewport from '../hooks/useChatViewport.js'
import useMediaQuery from '../hooks/useMediaQuery.js'
import usePresence from '../hooks/usePresence.js'
import { flushSync } from 'react-dom'
import useAppNavigation from '../hooks/useAppNavigation.js'
import useUserDirectory from '../hooks/useUserDirectory.js'
import { matchingConversations } from '../utils/navigation.js'
import BottomNavigation from '../components/navigation/BottomNavigation.jsx'
import PeopleList from '../components/navigation/PeopleList.jsx'
import { ProfilePage, SettingsPage } from '../components/navigation/AccountPages.jsx'
import ConversationListItem from '../components/chat/ConversationListItem.jsx'
import ConversationActions from '../components/chat/ConversationActions.jsx'
import EmptyState from '../components/chat/EmptyState.jsx'
import ConnectionStatus from '../components/chat/ConnectionStatus.jsx'
import Icon, { HelixMark } from '../components/ui/Icon.jsx'
import useOptimisticMessages from '../hooks/useOptimisticMessages.js'
import ChatPanel from '../components/ChatPanel.jsx'
import { getConversations, deleteConversation } from '../services/api.js'
import { connectRealtime } from '../services/realtime.js'
import { ProfileSurface } from '../components/profile/ProfilePanel.jsx'
import { useIdentity } from '../components/profile/IdentityProvider.jsx'

function sortRecent(conversations) {
  return [...conversations].sort((a, b) => {
    if (!a.last_message || !b.last_message) return Number(Boolean(b.last_message)) - Number(Boolean(a.last_message)) || b.id - a.id
    return Date.parse(b.last_message.created_at) - Date.parse(a.last_message.created_at) || b.last_message.id - a.last_message.id || b.id - a.id
  }).slice(0, 50)
}

export default function HomePage({ user, token, error, onLogout, onUnauthorized, theme, onToggleTheme }) {
  useChatViewport()
  const identity = useIdentity()
  const updateIdentity = identity?.update
  const desktop = useMediaQuery('(min-width: 768px)')
  const [connectionState, setConnectionState] = useState('connecting')
  const navigation = useAppNavigation()
  const { route } = navigation
  const chatVisible = desktop || (route.chat !== null && !route.search)
  const [search, setSearch] = useState('')
  const [contactSearch, setContactSearch] = useState('')
  const [searchTab, setSearchTab] = useState('chats')
  const searchInput = useRef(null)
  const searchButton = useRef(null)
  const panels = useRef({})
  const scrollPositions = useRef({})
  const peers = useRef(new Map())
  const [selectedUser, setSelectedUser] = useState(null)
  const [profilePeer, setProfilePeer] = useState(null)
  const closeProfile = useCallback(() => setProfilePeer(null), [])
  const [selectedConversation, setSelectedConversation] = useState(null)
  const [recent, setRecent] = useState([])
  const [recentLoading, setRecentLoading] = useState(true)
  const [recentError, setRecentError] = useState('')
  const [conversationAttempt, setConversationAttempt] = useState(0)
  const presence = usePresence(token, onUnauthorized)
  const onlineUserIds = presence.onlineIds
  const [pageVisible, setPageVisible] = useState(document.visibilityState === 'visible')
  const directory = useUserDirectory({ token, userId: user.id,
    enabled: route.search ? searchTab === 'people' : route.screen === 'contacts',
    query: route.search ? search : contactSearch, onUnauthorized })
  const filteredRecent = matchingConversations(recent, search)
  const messageListeners = useRef(new Set())
  const syncListeners = useRef(new Set())
  const mutationListeners = useRef(new Set())
  const typingListeners = useRef(new Set())
  const statusListeners = useRef(new Set())
  const realtime = useRef(null)
  const recentController = useRef(null)
  const activeConversationId = useRef(null)
  const recentTimer = useRef(null)
  const [chatActions, setChatActions] = useState(null), [removing, setRemoving] = useState(new Set())
  const removalTimers = useRef(new Map()), selection = useRef(null)
  selection.current = selectedUser ? { id: activeConversationId.current, other_user: selectedUser } : null
  const closeChatActions = useCallback(() => setChatActions(null), [])
  const openChatActions = useCallback((conversation, element) => {
    setChatActions({ conversation, rect: element.getBoundingClientRect() })
  }, [])

  const refreshRecent = useCallback(async () => {
    recentController.current?.abort()
    const controller = new AbortController()
    recentController.current = controller
    setRecentLoading(true)
    setRecentError('')
    try {
      const loaded = await getConversations(token, controller.signal)
      if (controller.signal.aborted) return
      for (const item of loaded) { peers.current.set(item.other_user.id, { peer: item.other_user, conversation: item }); updateIdentity?.(item.other_user) }
      setRecent(sortRecent(loaded))
    } catch (error) {
      if (controller.signal.aborted || error.name === 'AbortError') return
      if (error.status === 401) onUnauthorized()
      else setRecentError('Unable to load conversations.')
    } finally {
      if (!controller.signal.aborted) setRecentLoading(false)
    }
  }, [token, onUnauthorized, updateIdentity])

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

  const clearConversationView = useCallback(({ conversation_id }) => {
    recentController.current?.abort()
    if (selection.current?.id === conversation_id) {
      peers.current.delete(selection.current.other_user.id)
      setSelectedUser(null); setSelectedConversation(null); activeConversationId.current = null
      navigation.navigate({ screen: 'chats', search: false, chat: null }, true)
    }
    if (removalTimers.current.has(conversation_id)) return
    setRemoving(current => new Set([...current, conversation_id]))
    const timer = setTimeout(() => {
      removalTimers.current.delete(conversation_id)
      setRecent(current => current.filter(item => item.id !== conversation_id))
      setRemoving(current => { const next = new Set(current); next.delete(conversation_id); return next })
      // Read authoritative state again: a concurrent new message may revive it.
      refreshRecent()
    }, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 190)
    removalTimers.current.set(conversation_id, timer)
  }, [refreshRecent, navigation.navigate])
  useEffect(() => () => { for (const timer of removalTimers.current.values()) clearTimeout(timer); removalTimers.current.clear() }, [])
  async function removeConversation(conversation) {
    try { clearConversationView(await deleteConversation(token, conversation.id)) }
    catch (error) { if (error.status === 401) onUnauthorized(); throw error }
  }


  useEffect(() => {
    if (!token) return
    const connection = connectRealtime(token, {
      onConversationCleared: clearConversationView,
      onProfile: updateIdentity,
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
      onPresenceSnapshot: (ids, metadata) => { setConnectionState('connected'); presence.snapshot(ids, metadata); refreshRecent() },
      onPresenceUpdate: presence.update,
      onTyping: (event) => {
        for (const listener of typingListeners.current) listener(event)
      },
      onDisconnect: () => {
        setConnectionState('reconnecting')
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
  }, [token, onUnauthorized, user.id, acknowledge, updateRecentMessage, refreshRecent, handleMutation, wakeTimeline, presence.snapshot, presence.update, presence.disconnect, updateIdentity, clearConversationView])

  // Search and each destination have independent, retained scroll containers.
  const visiblePanel = route.search ? `search-${searchTab}` : route.screen
  useLayoutEffect(() => {
    const panel = panels.current[visiblePanel]
    if (panel) panel.scrollTop = scrollPositions.current[visiblePanel] || 0
  }, [visiblePanel, route.chat, directory.pending])

  useEffect(() => {
    if (!route.chat || route.chat === selectedUser?.id) return
    const remembered = peers.current.get(route.chat)
    if (!remembered) return
    setSelectedUser(remembered.peer)
    setSelectedConversation(remembered.conversation)
    activeConversationId.current = remembered.conversation?.id || null
    setConversationAttempt(attempt => attempt + 1)
  }, [route.chat, selectedUser?.id])

  useEffect(() => {
    function escape(event) {
      if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented || document.querySelector('[role="dialog"]')) return
      if (route.chat && !desktop) navigation.back()
      else if (route.search || route.screen !== 'chats') navigation.back()
    }
    document.addEventListener('keydown', escape)
    return () => document.removeEventListener('keydown', escape)
  }, [route, desktop, navigation.back])

  function openSearch() {
    setSearch('')
    setSearchTab('chats')
    // Focus inside the tap handler so Android can open its keyboard naturally.
    flushSync(() => navigation.navigate({ ...route, search: true }))
    searchInput.current?.focus({ preventScroll: true })
  }
  const wasSearching = useRef(false)
  useLayoutEffect(() => {
    if (wasSearching.current && !route.search && (desktop || !route.chat)) searchButton.current?.focus({ preventScroll: true })
    wasSearching.current = route.search
  }, [route.search, route.chat, desktop])

  function selectConversation(peer, conversation = null) {
    if (peer.id === user.id) return
    const existing = conversation || recent.find(item => item.other_user.id === peer.id) || null
    peers.current.set(peer.id, { peer, conversation: existing })
    if (!navigation.navigate({ screen: 'chats', search: false, chat: peer.id }, route.chat !== null && !route.search)) return
    if (selectedUser?.id === peer.id) return
    setSelectedUser(peer)
    setSelectedConversation(existing)
    activeConversationId.current = existing?.id || null
    setConversationAttempt(attempt => attempt + 1)
  }
  function backToChats() { navigation.back() }

  function conversationList(items, searching = false) {
    return <>
      {recentError && <div className="sidebar-error"><p role="alert">{recentError}</p><button type="button" className="text-button" onClick={refreshRecent}>Retry conversations</button></div>}
      {recentLoading && recent.length === 0 ? <div className="conversation-skeleton" role="status" aria-label="Loading conversations"><span /><span /><span /></div>
        : !recentError && items.length === 0 ? <EmptyState compact title={searching ? 'No matching chats.' : 'No conversations yet.'}>{searching ? 'Try another username or search People.' : 'Tap New chat to start a conversation.'}</EmptyState>
        : <ul aria-label={searching ? 'Matching conversations' : 'Recent conversations'} className="conversation-list">
          {items.map(conversation => <ConversationListItem key={conversation.id} conversation={conversation} userId={user.id} selected={selectedUser?.id === conversation.other_user.id} active={selectedUser?.id === conversation.other_user.id && pageVisible && chatVisible} online={onlineUserIds.has(conversation.other_user.id)} onSelect={selectConversation} onProfile={setProfilePeer} onActions={openChatActions} removing={removing.has(conversation.id)} />)}
        </ul>}
    </>
  }
  function panelProps(name) {
    return { ref: element => { panels.current[name] = element }, hidden: visiblePanel !== name,
      onScroll: event => { if (event.currentTarget.clientHeight > 0) scrollPositions.current[name] = event.currentTarget.scrollTop }, className: 'sidebar-content navigation-surface' }
  }
  const titles = { chats: 'Chats', contacts: 'Contacts', settings: 'Settings', profile: 'Profile' }

  return (
    <section aria-labelledby="directory-title" className="chat-shell" data-chat-open={route.chat !== null && !route.search}>
      <div className="chat-sidebar">
        <header className="sidebar-header navigation-header" data-searching={route.search}>
          <div className="navigation-titlebar" hidden={route.search}>
            {route.screen === 'chats' ? <span className="brand-mark"><HelixMark /></span> : <button type="button" className="icon-button" aria-label="Back" onClick={navigation.back}><Icon name="back" /></button>}
            <h1 id="directory-title">{route.screen === 'chats' ? <><span className="navigation-brand">helix<span className="brand-period">.</span></span><span className="sr-only"> Chats</span></> : titles[route.screen]}</h1>
            {route.screen === 'chats' && <button ref={searchButton} type="button" className="icon-button" aria-label="Search" onClick={openSearch}><Icon name="search" /></button>}
          </div>
          <div className="navigation-searchbar" hidden={!route.search}>
            <button type="button" className="icon-button" aria-label="Close search" onClick={navigation.back}><Icon name="back" /></button>
            <div className="search-field">
              <label htmlFor="chat-search" className="sr-only">Search by username</label>
              <input ref={searchInput} id="chat-search" type="search" placeholder="Search usernames" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={search} onChange={event => { scrollPositions.current["search-chats"] = 0; scrollPositions.current["search-people"] = 0; setSearch(event.target.value) }} />
              {search && <button type="button" className="icon-button" aria-label="Clear search" onClick={() => { setSearch(''); searchInput.current?.focus() }}><Icon name="close" size={17} /></button>}
            </div>
          </div>
          {route.search && <div className="search-tabs" role="tablist" aria-label="Search in">{['chats', 'people'].map(tab => <button type="button" key={tab} id={`tab-${tab}`} role="tab" aria-controls={`results-${tab}`} aria-selected={searchTab === tab} tabIndex={searchTab === tab ? 0 : -1} onClick={() => setSearchTab(tab)} onKeyDown={event => {
            if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const next = ['Home', 'End'].includes(event.key) ? (event.key === 'Home' ? 'chats' : 'people') : tab === 'chats' ? 'people' : 'chats'; setSearchTab(next); document.getElementById(`tab-${next}`)?.focus() }
          }}>{tab === 'chats' ? 'Chats' : 'People'}</button>)}</div>}
          {!route.search && route.screen === 'contacts' && <div className="search-field contacts-search">
            <Icon name="search" size={18} /><label htmlFor="user-search" className="sr-only">Search contacts by username</label>
            <input id="user-search" type="search" placeholder="Find someone…" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={contactSearch} onChange={event => { scrollPositions.current.contacts = 0; setContactSearch(event.target.value) }} />
            {contactSearch && <button type="button" className="icon-button" aria-label="Clear contacts search" onClick={() => { setContactSearch(''); document.getElementById('user-search')?.focus() }}><Icon name="close" size={17} /></button>}
          </div>}
        </header>
        <ConnectionStatus state={connectionState} />
        {error && <p role="alert" className="form-error m-3">{error}</p>}
        <div className="navigation-body">
          <div {...panelProps('chats')} aria-label="Chats">{conversationList(recent)}</div>
          <div {...panelProps('contacts')} aria-label="User directory">{visiblePanel === 'contacts' && <PeopleList directory={directory} onlineIds={onlineUserIds} selectedId={selectedUser?.id} onSelect={selectConversation} onProfile={setProfilePeer} query={contactSearch} />}</div>
          <div {...panelProps('search-chats')} id="results-chats" role="tabpanel" aria-labelledby="tab-chats">{route.search && conversationList(filteredRecent, true)}</div>
          <div {...panelProps('search-people')} id="results-people" role="tabpanel" aria-labelledby="tab-people">{visiblePanel === 'search-people' && <PeopleList directory={directory} onlineIds={onlineUserIds} selectedId={selectedUser?.id} onSelect={selectConversation} onProfile={setProfilePeer} query={search} />}</div>
          <div {...panelProps('settings')}>{visiblePanel === 'settings' && <SettingsPage theme={theme} onToggleTheme={onToggleTheme} />}</div>
          <div {...panelProps('profile')}>{visiblePanel === 'profile' && <ProfilePage user={user} onLogout={onLogout} />}</div>
          {route.screen === 'chats' && !route.search && <button type="button" className="new-chat-button" aria-label="New chat" title="New chat" onClick={() => navigation.tab('contacts')}><Icon name="compose" size={22} /></button>}
        </div>
        <BottomNavigation screen={route.screen} onNavigate={navigation.tab} />
      </div>
      <aside aria-label="Conversation" className="conversation-pane">
        {selectedUser ? <>
          <ConnectionStatus state={connectionState} />
          <ChatPanel active={chatVisible} lastSeen={presence.lastSeen.get(selectedUser.id)} now={presence.now} optimistic={optimistic} onBack={backToChats} onProfile={setProfilePeer} key={`${selectedUser.id}:${conversationAttempt}`} user={user} selectedUser={selectedUser} initialConversation={selectedConversation} onConversationOpened={onConversationOpened} onMessageSent={updateRecentMessage} onMessageMutated={handleMutation} subscribeToMutations={subscribeToMutations} subscribeToSync={subscribeToSync} token={token} onUnauthorized={onUnauthorized} subscribeToMessages={subscribeToMessages} subscribeToStatus={subscribeToStatus} acknowledge={acknowledge} subscribeToTyping={subscribeToTyping} sendTyping={sendTyping} isOnline={onlineUserIds.has(selectedUser.id)} />
        </> : <EmptyState title="Good conversations start with hello.">Choose a chat or find someone to talk to.</EmptyState>}
      </aside>
      {profilePeer && <ProfileSurface user={profilePeer} online={onlineUserIds.has(profilePeer.id)} lastSeen={presence.lastSeen.get(profilePeer.id)} onClose={closeProfile} onChat={selectConversation} />}
      {chatActions && <ConversationActions target={chatActions} onClose={closeChatActions} onDelete={removeConversation} />}
    </section>
  )
}
