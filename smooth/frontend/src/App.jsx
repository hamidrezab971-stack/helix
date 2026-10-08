import { useCallback, useEffect, useState } from 'react'
import { AuthCard } from './components/AuthCard.jsx'
import HomePage from './pages/HomePage.jsx'
import LoginPage from './pages/LoginPage.jsx'
import RegisterPage from './pages/RegisterPage.jsx'
import { getCurrentUser, login } from './services/api.js'

const TOKEN_KEY = 'smooth_access_token'

export default function App() {
  const [page, setPage] = useState('login')
  const [user, setUser] = useState(null)
  const [token, setToken] = useState(null)
  const [checking, setChecking] = useState(true)
  const [restoreError, setRestoreError] = useState('')
  const [restoreAttempt, setRestoreAttempt] = useState(0)
  const [loginUsername, setLoginUsername] = useState('')
  const [notice, setNotice] = useState('')
  const [logoutError, setLogoutError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    let active = true

    async function restoreAuthentication() {
      try {
        const token = localStorage.getItem(TOKEN_KEY)
        if (token) {
          const currentUser = await getCurrentUser(token, controller.signal)
          if (active) {
            setUser(currentUser)
            setToken(token)
          }
        }
      } catch (error) {
        if (!active || error.name === 'AbortError') return
        if (error.status === 401) {
          try {
            localStorage.removeItem(TOKEN_KEY)
            setNotice('Your sign-in has expired. Please log in again.')
          } catch {
            setRestoreError('Unable to clear browser storage. Please allow storage and try again.')
          }
        } else {
          setRestoreError(error.displayMessage || 'Unable to load your account. Please try again.')
        }
      } finally {
        if (active) setChecking(false)
      }
    }

    restoreAuthentication()
    return () => {
      active = false
      controller.abort()
    }
  }, [restoreAttempt])

  async function handleLogin(username, password) {
    setNotice('')
    const { access_token: token } = await login(username, password)
    try {
      localStorage.setItem(TOKEN_KEY, token)
    } catch {
      const error = new Error('Browser storage is unavailable.')
      error.displayMessage = 'Unable to save your sign-in. Please allow browser storage and try again.'
      throw error
    }
    try {
      const currentUser = await getCurrentUser(token)
      setUser(currentUser)
      setToken(token)
      setLoginUsername(currentUser.username)
      setNotice('')
    } catch (error) {
      if (error.status === 401) localStorage.removeItem(TOKEN_KEY)
      throw error
    }
  }

  function handleLogout() {
    try {
      localStorage.removeItem(TOKEN_KEY)
    } catch {
      setLogoutError('Unable to log out. Please allow browser storage and try again.')
      return
    }
    setUser(null)
    setToken(null)
    setPage('login')
    setLogoutError('')
    setNotice('You’ve been logged out.')
  }

  const handleUnauthorized = useCallback(() => {
    let message = 'Your sign-in has expired. Please log in again.'
    try {
      localStorage.removeItem(TOKEN_KEY)
    } catch {
      message = 'Unable to clear browser storage. Please allow storage before logging in again.'
    }
    setUser(null)
    setToken(null)
    setPage('login')
    setLogoutError('')
    setNotice(message)
  }, [])

  let content
  if (checking) {
    content = (
      <div role="status" className="flex items-center gap-3 text-sm text-stone-600">
        <span aria-hidden="true" className="h-4 w-4 animate-spin rounded-full border-2 border-stone-200 border-t-[#b65339] motion-reduce:animate-none" />
        Loading Smooth...
      </div>
    )
  } else if (restoreError) {
    content = (
      <AuthCard title="Let’s try that again." description={restoreError}>
        <button type="button" className="primary-button w-full" onClick={() => {
          setRestoreError('')
          setChecking(true)
          setRestoreAttempt((attempt) => attempt + 1)
        }}>Try again</button>
      </AuthCard>
    )
  } else if (user) {
    content = <HomePage user={user} token={token} error={logoutError} onLogout={handleLogout} onUnauthorized={handleUnauthorized} />
  } else if (page === 'register') {
    content = <RegisterPage onLogin={() => setPage('login')} onRegistered={(registeredUser) => {
      setLoginUsername(registeredUser.username)
      setNotice('Account created. Log in to get started.')
      setPage('login')
    }} />
  } else {
    content = <LoginPage initialUsername={loginUsername} notice={notice} onLogin={handleLogin} onRegister={() => {
      setNotice('')
      setPage('register')
    }} />
  }

  return (
    <div className="app-shell flex min-h-svh flex-col px-5 sm:px-8">
      <header className="mx-auto flex w-full max-w-5xl items-center justify-between py-7 sm:py-9">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#b65339] shadow-sm">
            <svg aria-hidden="true" viewBox="0 0 32 32" fill="none" className="h-7 w-7 text-white">
              <path d="M23 9c-3-4-13-3-13 2s13 3 13 9-10 7-15 2" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
            </svg>
          </span>
          <span className="text-xl font-semibold tracking-tight text-stone-900">Smooth</span>
        </div>
        <p className="hidden text-sm text-stone-500 sm:block">A modern messaging application.</p>
      </header>
      <main className="flex flex-1 items-center justify-center py-8 sm:py-12">{content}</main>
      <footer className="py-7 text-center text-xs tracking-wide text-stone-500">Simple by design.</footer>
    </div>
  )
}
