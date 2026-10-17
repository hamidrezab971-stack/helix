import { useCallback, useEffect, useState } from 'react'
import { AuthCard } from './components/AuthCard.jsx'
import HomePage from './pages/HomePage.jsx'
import LoginPage from './pages/LoginPage.jsx'
import RegisterPage from './pages/RegisterPage.jsx'
import useTheme from './hooks/useTheme.js'
import Icon, { HelixMark } from './components/ui/Icon.jsx'
import { getCurrentUser, login } from './services/api.js'
import { IdentityProvider } from './components/profile/IdentityProvider.jsx'

const TOKEN_KEY = 'smooth_access_token'

export default function App() {
  const [theme, toggleTheme] = useTheme()
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

  async function handleLogin(username, password, altcha) {
    setNotice('')
    const { access_token: token } = await login(username, password, altcha)
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
      <div role="status" className="auth-loading">
        <span aria-hidden="true" className="loading-spinner" />
        Opening Helix…
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
    content = <HomePage theme={theme} onToggleTheme={toggleTheme} user={user} token={token} error={logoutError} onLogout={handleLogout} onUnauthorized={handleUnauthorized} />
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

  if (user && !checking && !restoreError) return <IdentityProvider token={token} onUnauthorized={handleUnauthorized}><main className="messaging-app">{content}</main></IdentityProvider>

  return (
    <div className="app-shell">
      <header className="auth-header">
        <a className="brand" href="#" aria-label="Helix home" onClick={event => { event.preventDefault(); setPage('login') }}><span className="brand-mark"><HelixMark /></span><span>helix<span className="brand-period">.</span></span></a>
        <button type="button" className="icon-button" aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`} onClick={toggleTheme}><Icon name={theme === 'dark' ? 'sun' : 'moon'} /></button>
      </header>
      <main className="auth-main">{content}</main>
      <footer className="auth-footer">A little closer. A little simpler.</footer>
    </div>
  )
}
