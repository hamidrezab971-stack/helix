import { useRef, useState } from 'react'
import { AuthCard, FormField } from '../components/AuthCard.jsx'

export default function LoginPage({ initialUsername, notice, onLogin, onRegister }) {
  const [username, setUsername] = useState(initialUsername)
  const [password, setPassword] = useState('')
  const [errors, setErrors] = useState({})
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const pending = useRef(false)

  async function handleSubmit(event) {
    event.preventDefault()
    if (pending.current) return
    setError('')
    const nextErrors = {}
    if (!username.trim()) nextErrors.username = 'Enter your username.'
    if (!password) nextErrors.password = 'Enter your password.'
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length) return

    pending.current = true
    setSubmitting(true)
    try {
      await onLogin(username, password)
    } catch (error) {
      setError(error.displayMessage || 'Something went wrong. Please try again.')
    } finally {
      pending.current = false
      setSubmitting(false)
    }
  }

  return (
    <AuthCard title="Welcome back." description="Log in to your Smooth account.">
      {notice && <p role="status" className="mb-6 rounded-xl bg-emerald-50 px-4 py-3 text-sm leading-6 text-emerald-800">{notice}</p>}
      <form onSubmit={handleSubmit} noValidate aria-busy={submitting} className="space-y-5">
        <FormField
          id="login-username" label="Username" type="text" autoComplete="username"
          autoCapitalize="none" autoCorrect="off" spellCheck={false} required
          value={username} onChange={(event) => setUsername(event.target.value)}
          error={errors.username} disabled={submitting}
        />
        <FormField
          id="login-password" label="Password" type="password" autoComplete="current-password" required
          value={password} onChange={(event) => setPassword(event.target.value)}
          error={errors.password} disabled={submitting}
        />
        {error && <p role="alert" className="form-error">{error}</p>}
        <button type="submit" className="primary-button w-full" disabled={submitting}>
          {submitting ? 'Logging in...' : 'Log in'}
        </button>
      </form>
      <p className="mt-7 text-center text-sm leading-6 text-stone-500">
        Don’t have an account?{' '}
        <button type="button" className="text-button" onClick={onRegister} disabled={submitting}>Create one</button>
      </p>
    </AuthCard>
  )
}
