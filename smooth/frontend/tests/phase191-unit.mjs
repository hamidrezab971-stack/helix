import test from 'node:test'
import assert from 'node:assert/strict'
import { createNavigationController, initialNavigation, matchingConversations } from '../src/utils/navigation.js'

function browserHistory() {
  const entries = [{}]
  let index = 0, pending = null
  const history = {
    get state() { return entries[index] },
    get length() { return entries.length },
    pushState(state) { entries.splice(++index); entries[index] = structuredClone(state) },
    replaceState(state) { entries[index] = structuredClone(state) },
    go(delta) { pending = index + delta },
    back() { this.go(-1) },
    flush(controller) { assert.notEqual(pending, null); assert.ok(pending >= 0); index = pending; pending = null; controller.pop() },
  }
  return history
}
function fixture() {
  const history = browserHistory(), controller = createNavigationController(history, 'signed-in-session')
  let route
  controller.start(next => { route = next })
  return { history, controller, get route() { return route } }
}

test('Contacts > conversation > browser Back restores Contacts, then Chats', () => {
  const f = fixture()
  f.controller.tab('contacts')
  f.controller.navigate({ screen: 'chats', search: false, chat: 17 })
  f.controller.back(); f.history.flush(f.controller)
  assert.deepEqual(f.route, { screen: 'contacts', search: false, chat: null })
  f.controller.back(); f.history.flush(f.controller)
  assert.deepEqual(f.route, initialNavigation)
})
test('Search > chat > Back restores search before closing to its origin', () => {
  const f = fixture()
  const search = { screen: 'chats', search: true, chat: null }
  f.controller.navigate(search)
  f.controller.navigate({ screen: 'chats', search: false, chat: 27 })
  f.controller.back(); f.history.flush(f.controller)
  assert.deepEqual(f.route, search)
  f.controller.back(); f.history.flush(f.controller)
  assert.deepEqual(f.route, initialNavigation)
})
test('Tab changes collapse old search and chat entries, with a single Back to Chats', () => {
  const f = fixture()
  f.controller.tab('contacts')
  f.controller.navigate({ screen: 'chats', search: false, chat: 27 })
  f.controller.tab('settings'); f.history.flush(f.controller)
  assert.equal(f.route.screen, 'settings')
  assert.equal(f.history.state.helixNavigation.depth, 1)
  assert.equal(f.history.length, 2)
  f.controller.tab('profile'); f.history.flush(f.controller)
  assert.equal(f.route.screen, 'profile')
  f.controller.back(); f.history.flush(f.controller)
  assert.deepEqual(f.route, initialNavigation)
})
test('Re-selecting a tab adds no entry; repeated Back taps cannot consume two screens', () => {
  const f = fixture()
  f.controller.tab('contacts'); f.controller.tab('contacts')
  assert.equal(f.history.length, 2)
  f.controller.back(); f.controller.back()
  assert.equal(f.controller.navigate({ screen: 'profile', search: false, chat: null }), false)
  f.history.flush(f.controller)
  assert.deepEqual(f.route, initialNavigation)
})
test('Message overlay history dismisses without closing its underlying conversation', () => {
  const f = fixture()
  const chat = { screen: 'chats', search: false, chat: 27 }
  f.controller.navigate(chat)
  f.history.pushState({ ...f.history.state, smoothOverlay: 'message-menu' })
  f.history.back(); f.history.flush(f.controller)
  assert.deepEqual(f.route, chat)
  f.controller.back(); f.history.flush(f.controller)
  assert.deepEqual(f.route, initialNavigation)
})
test('Fresh login does not restore a previous account conversation from history', () => {
  const f = fixture()
  f.controller.navigate({ screen: 'chats', search: false, chat: 27 })
  const next = createNavigationController(f.history, 'another-account')
  let route
  next.start(value => { route = value })
  f.history.back(); f.history.flush(next)
  assert.deepEqual(route, initialNavigation)
  assert.equal(f.history.state.helixNavigation.session, 'another-account')
})
test('Conversation search matches usernames case-insensitively without fabricating message search', () => {
  const conversations = [{ id: 1, other_user: { username: 'Alice' }, last_message: { content: 'Bob' } }, { id: 2, other_user: { username: 'Bob_2' } }]
  assert.deepEqual(matchingConversations(conversations, '  ALI '), [conversations[0]])
  assert.deepEqual(matchingConversations(conversations, 'bob'), [conversations[1]])
  assert.deepEqual(matchingConversations(conversations, 'سلام'), [])
  assert.deepEqual(matchingConversations(conversations, ''), conversations)
  assert.equal(conversations.length, 2)
})
