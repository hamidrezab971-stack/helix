import { useEffect, useState } from 'react'
import ChatPanel from '../components/ChatPanel.jsx'
import { getUsers } from '../services/api.js'

export default function HomePage({ user, token, error, onLogout, onUnauthorized }) {
  const [search, setSearch] = useState('')
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [retryAttempt, setRetryAttempt] = useState(0)
  const [selectedUser, setSelectedUser] = useState(null)
  const [conversationAttempt, setConversationAttempt] = useState(0)
  const normalizedSearch = search.trim().toLowerCase()

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
          <h1 id="directory-title" className="text-2xl font-semibold tracking-tight text-stone-900">Find your people.</h1>
          <p className="mt-2 text-sm text-stone-500">Browse the Smooth directory.</p>
        </div>
        <div className="flex min-w-0 items-center justify-between gap-4">
          <span className="min-w-0 break-all text-sm font-medium text-stone-700">@{user.username}</span>
          <button type="button" className="secondary-button shrink-0" onClick={onLogout}>Log out</button>
        </div>
      </header>
      {error && <p role="alert" className="form-error m-6">{error}</p>}
      <div className="grid md:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
        <section aria-label="User directory" className="min-w-0 p-6 sm:p-8">
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
                        setConversationAttempt((attempt) => attempt + 1)
                      }}
                    >
                      <span className="min-w-0 break-all font-medium">@{directoryUser.username}</span>
                      {selectedUser?.id === directoryUser.id && <span className="shrink-0 text-xs font-semibold">Selected</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
        <aside aria-label="Conversation" className="min-w-0 border-t border-stone-200/80 bg-[#fcfbf9] md:border-t-0 md:border-l">
          {selectedUser ? (
            <ChatPanel key={`${selectedUser.id}:${conversationAttempt}`} user={user} selectedUser={selectedUser} token={token} onUnauthorized={onUnauthorized} />
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
