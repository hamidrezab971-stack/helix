import test from 'node:test'
import './phase20-components.jsx'
import './phase211-components.jsx'
import assert from 'node:assert/strict'
import { renderToStaticMarkup as render } from 'react-dom/server'
import LoginPage from '../src/pages/LoginPage.jsx'
import RegisterPage from '../src/pages/RegisterPage.jsx'
import MessageBubble from '../src/components/chat/MessageBubble.jsx'
import ChatComposer from '../src/components/chat/ChatComposer.jsx'
import ChatHeader from '../src/components/chat/ChatHeader.jsx'
import ConversationListItem from '../src/components/chat/ConversationListItem.jsx'
import BottomNavigation from '../src/components/navigation/BottomNavigation.jsx'
import PeopleList from '../src/components/navigation/PeopleList.jsx'
import { ProfilePage, SettingsPage } from '../src/components/navigation/AccountPages.jsx'
import HomePage from '../src/pages/HomePage.jsx'

const noop = () => {}
const message = { id: 92, sender_id: 1, conversation_id: 3, created_at: '2026-10-17T12:30:00Z', content: 'سلام <script> & hello', reactions: [] }
const bubbleProps = { message, own: true, name: 'Alice', token: 'test', onUnauthorized: noop, onOpen: noop, onPhoto: noop, onNavigate: noop, onChanged: noop, userId: 1 }

test('Chats starts with a compose destination and no rendered permanent user directory', () => {
  const saved = { document: globalThis.document, matchMedia: globalThis.matchMedia, history: globalThis.history }
  try {
    globalThis.document = { visibilityState: 'visible' }
    globalThis.matchMedia = () => ({ matches: false })
    globalThis.history = {}
    const markup = render(<HomePage user={{ id: 1, username: 'alice', created_at: message.created_at }} token="test" theme="dark" onToggleTheme={noop} onUnauthorized={noop} onLogout={noop} />)
    assert.match(markup, /aria-label="New chat"/)
    assert.match(markup, /aria-label="Search"/)
    assert.ok(!markup.includes('class="user-row"'))
    assert.ok(!markup.includes('id="user-search"'))
    assert.match(markup, /class="navigation-searchbar" hidden/)
    assert.match(markup, /data-chat-open="false"/)
  } finally { Object.assign(globalThis, saved) }
})

test('All four navigation destinations have named buttons and a single active state', () => {
  const markup = render(<BottomNavigation screen="contacts" onNavigate={noop} />)
  for (const label of ['Chats', 'Contacts', 'Settings', 'Profile']) assert.ok(markup.includes(`${label}</button>`))
  assert.equal((markup.match(/aria-current="page"/g) || []).length, 1)
})

test('People exposes actual presence, username, delayed loading, empty and recoverable error states', () => {
  const props = { directory: { users: [{ id: 2, username: 'bob' }], pending: false }, onlineIds: new Set([2]), onSelect: noop, query: '' }
  const markup = render(<PeopleList {...props} />)
  assert.match(markup, /@bob/)
  assert.match(markup, /data-online="true">online/)
  assert.match(render(<PeopleList {...props} directory={{ users: [], pending: false }} query="missing" />), /No people found/)
  assert.match(render(<PeopleList {...props} directory={{ pending: true, loading: true }} />), /role="status"/)
  assert.ok(!render(<PeopleList {...props} directory={{ pending: true, loading: false }} />).includes('Looking for people'))
  assert.match(render(<PeopleList {...props} directory={{ pending: false, error: 'Unavailable', retry: noop }} />), /Try again/)
})

test('Profile shows authenticated fields and Settings offers only the supported theme preference', () => {
  const markup = render(<ProfilePage user={{ username: 'alice', created_at: message.created_at }} onLogout={noop} />)
  assert.match(markup, /@alice/)
  assert.match(markup, /Member since/)
  assert.match(markup, /Log out/)
  const settings = render(<SettingsPage theme="dark" onToggleTheme={noop} />)
  assert.match(settings, /Switch to light theme/)
  assert.ok(!settings.includes('password'))
})

test('Authentication retains field labels, autocomplete, validation hints, and submit controls', () => {
  const login = render(<LoginPage initialUsername="alice" notice="" onLogin={noop} onRegister={noop} />)
  assert.match(login, /id="login-username"/)
  assert.match(login, /autoComplete="username"/)
  assert.match(login, /autoComplete="current-password"/)
  assert.match(login, /type="submit"[^>]*>Log in/)
  const register = render(<RegisterPage onRegistered={noop} onLogin={noop} />)
  for (const field of ['register-username', 'register-password', 'register-confirmation']) assert.ok(register.includes(`id="${field}"`))
  assert.match(register, /3–30 letters/)
  assert.match(register, /8–128 characters/)
})

test('Messages escape mixed-direction content and expose real receipts and a keyboard action button', () => {
  const sent = render(<MessageBubble {...bubbleProps} />)
  assert.match(sent, /dir="auto"/)
  assert.ok(sent.includes('سلام &lt;script&gt; &amp; hello'))
  assert.match(sent, /aria-label="Message actions"/)
  assert.match(sent, /aria-haspopup="dialog"/)
  assert.match(sent, />Sent</)
  for (const [receipt, state] of [['delivered_at', 'Delivered'], ['read_at', 'Read']]) {
    const markup = render(<MessageBubble {...bubbleProps} message={{ ...message, [receipt]: '2026-10-17T12:31:00Z' }} />)
    assert.ok(markup.includes(`>${state}<`))
  }
  assert.ok(!render(<MessageBubble {...bubbleProps} own={false} />).includes('aria-label="Message status"'))
})

test('Bubbles keep canonical IDs, grouped state, personalized reactions, and actual reply previews', () => {
  const markup = render(<MessageBubble {...bubbleProps} grouped message={{ ...message, reply_to: { id: 18, sender_id: 1, content: 'Original message' }, reactions: [{ emoji: '❤️', count: 2, reacted_by_me: true }] }} />)
  assert.match(markup, /data-message-id="92"/)
  assert.match(markup, /data-grouped="true"/)
  assert.match(markup, /aria-label="Reply preview"/)
  assert.match(markup, /Original message/)
  assert.match(markup, /aria-pressed="true"/)
  assert.match(markup, /2 heart reactions. Remove your reaction/)
  assert.ok(!markup.includes('Choose reaction'))
})

test('Composer keeps upload restrictions, character limit, accessible controls, and focusable pending input', () => {
  const props = { content: 'Draft', onChange: noop, onSubmit: noop, onImage: noop, onRemoveImage: noop, onCancelReply: noop, replyName: () => 'Alice', replyText: reply => reply.content }
  const markup = render(<ChatComposer {...props} sending />)
  assert.match(markup, /accept="image\/jpeg,image\/png,image\/webp"/)
  assert.match(markup, /maxLength="2000"/i)
  assert.match(markup, /readOnly=""/i)
  assert.ok(!markup.match(/<textarea[^>]*disabled/))
  assert.match(markup, /aria-busy="true"/)
  assert.match(markup, /aria-label="Send"/)
  const empty = render(<ChatComposer {...props} content="" />)
  assert.match(empty, /aria-label="Send"[^>]*disabled/)
  const edit = render(<ChatComposer {...props} editing onCancelEdit={noop} />)
  assert.match(edit, /aria-label="Save"/)
  assert.match(edit, /aria-label="Cancel edit"/)
  assert.ok(!edit.includes('aria-label="Image"'))
})

test('Header shows animated typing only for actual typing and uses trustworthy last-seen values', () => {
  const props = { selectedUser: { username: 'alice' }, isOnline: false, onBack: noop, now: Date.parse('2026-10-17T12:35:00Z') }
  const offline = render(<ChatHeader {...props} />)
  assert.match(offline, />offline</)
  assert.ok(!offline.includes('typing-dots'))
  const typing = render(<ChatHeader {...props} otherTyping />)
  assert.match(typing, /typing-dots/)
  assert.match(typing, /alice is typing/)
  const lastSeen = render(<ChatHeader {...props} lastSeen="2026-10-17T12:30:00Z" />)
  assert.match(lastSeen, /last seen 5 minutes ago/)
})

test('Conversation summaries preserve photo previews, truncation content, and unread visibility rules', () => {
  const conversation = { id: 3, other_user: { id: 2, username: 'very_long_username' }, unread_count: 102, last_message: { ...message, attachment: { kind: 'image' } } }
  const props = { conversation, userId: 1, selected: true, active: false, online: true, onSelect: noop }
  const markup = render(<ConversationListItem {...props} />)
  assert.match(markup, /You: Photo ·/)
  assert.match(markup, /102 unread messages/)
  assert.match(markup, />99\+</)
  assert.match(markup, /data-online="true"/)
  assert.ok(!render(<ConversationListItem {...props} active />).includes('unread-badge'))
})

test('Each conversation keeps its online/offline avatar in a separate profile button beside its named chat button', () => {
  const conversation = { id: 3, other_user: { id: 2, username: 'bob' }, unread_count: 0 }
  for (const online of [true, false]) {
    const markup = render(<ConversationListItem conversation={conversation} userId={1} online={online} onSelect={noop} onProfile={noop} onActions={noop} />)
    const buttons = [...markup.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map(match => match[0])
    assert.equal(buttons.length, 3, 'profile, chat, actions remain independent buttons')
    assert.match(buttons[0], /aria-label="View bob&#x27;s profile"/)
    assert.match(buttons[0], new RegExp(`class="avatar-presence" data-online="${online}"`))
    assert.match(buttons[1], /class="recent-row"/)
    assert.match(buttons[1], /@bob/)
    assert.ok(!buttons[1].includes('avatar-presence'), 'legacy descendant locator cannot select the sibling indicator')
    assert.equal((markup.match(/class="avatar-presence"/g) || []).length, 1)
  }
})
