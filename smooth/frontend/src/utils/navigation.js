export const initialNavigation = { screen: 'chats', search: false, chat: null }
export const destinations = ['chats', 'contacts', 'settings', 'profile']

// Keep tab changes one level above Chats; overlays retain their own entries.
export function tabNavigation(screen) {
  return { screen: destinations.includes(screen) ? screen : 'chats', search: false, chat: null }
}

export function matchingConversations(conversations, query) {
  const search = query.trim().toLowerCase()
  return conversations.filter(item => item.other_user.username.toLowerCase().includes(search))
}

// Only peer IDs enter browser history; authentication stays in App.
export function createNavigationController(history, session) {
  let current = { session, depth: 0, route: initialNavigation }
  let publish = () => {}
  let goingBack = false
  let pendingTab = null
  function write(entry, replace) {
    const { smoothOverlay, helixChat, ...state } = history.state || {}
    history[replace ? 'replaceState' : 'pushState']({ ...state, helixNavigation: entry }, '')
    current = entry
    publish(entry.route)
  }
  function navigate(route, replace = false) {
    if (goingBack) return false
    write({ session, depth: current.depth + (replace ? 0 : 1), route }, replace)
    return true
  }
  function pop() {
    goingBack = false
    const entry = history.state?.helixNavigation
    if (entry?.session !== session) {
      pendingTab = null
      write({ session, depth: 0, route: initialNavigation }, true)
      return
    }
    current = entry
    if (pendingTab !== null) {
      const screen = pendingTab
      pendingTab = null
      if (screen !== 'chats') { navigate(tabNavigation(screen)); return }
    }
    publish(current.route)
  }
  function back() {
    if (goingBack) return
    if (current.depth > 0 && history.state?.helixNavigation?.session === session) {
      goingBack = true
      history.back()
    } else navigate(initialNavigation, true)
  }
  function tab(screen) {
    if (goingBack) return
    const next = tabNavigation(screen)
    if (current.route.screen === next.screen && !current.route.search && !current.route.chat) return
    if (current.depth > 0) {
      // Collapse tabs to the shared Chats root, including search/chat entries.
      pendingTab = next.screen
      goingBack = true
      history.go(-current.depth)
    } else if (next.screen !== 'chats') navigate(next)
  }
  return { navigate, back, tab, pop,
    start(listener) { publish = listener; write({ session, depth: 0, route: initialNavigation }, true) },
    stop() { publish = () => {} },
  }
}
