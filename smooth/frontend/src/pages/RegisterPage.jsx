import { useRef, useState } from 'react'
import { AuthCard, FormField } from '../components/AuthCard.jsx'
import { register } from '../services/api.js'

export default function RegisterPage({ onRegistered, onLogin }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [errors, setErrors] = useState({})
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const pending = useRef(false)

  async function handleSubmit(event) {
    event.preventDefault()
    if (pending.current) return
    setError('')
    const normalizedUsername = username.trim().toLowerCase()
    const nextErrors = {}
    if (!/^[a-z0-9_]{3,30}$/.test(normalizedUsername)) {
      nextErrors.username = 'Use 3–30 letters, numbers, or underscores.'
    }
    const passwordLength = Array.from(password).length
    if (passwordLength < 8 || passwordLength > 128) {
      nextErrors.password = 'Use between 8 and 128 characters.'
    }
    if (password !== confirmation) nextErrors.confirmation = 'Passwords do not match.'
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length) return

    pending.current = true
    setSubmitting(true)
    try {
      const user = await register(normalizedUsername, password)
      onRegistered(user)
    } catch (error) {
      setError(error.displayMessage || 'Something went wrong. Please try again.')
    } finally {
      pending.current = false
      setSubmitting(false)
    }
  }

  return (
    <AuthCard title="Create your account." description="A simple start to a little more connection.">
      <form onSubmit={handleSubmit} noValidate aria-busy={submitting} className="space-y-5">
        <FormField
          id="register-username" label="Username" type="text" autoComplete="username"
          autoCapitalize="none" autoCorrect="off" spellCheck={false} required
          hint="3–30 letters, numbers, or underscores."
          value={username} onChange={(event) => setUsername(event.target.value)}
          error={errors.username} disabled={submitting}
        />
        <FormField
          id="register-password" label="Password" type="password" autoComplete="new-password" required
          hint="8–128 characters. Make it your own."
          value={password} onChange={(event) => setPassword(event.target.value)}
          error={errors.password} disabled={submitting}
        />
        <FormField
          id="register-confirmation" label="Confirm password" type="password" autoComplete="new-password" required
          value={confirmation} onChange={(event) => setConfirmation(event.target.value)}
          error={errors.confirmation} disabled={submitting}
        />
        {error && <p role="alert" className="form-error">{error}</p>}
        <button type="submit" className="primary-button w-full" disabled={submitting}>
          {submitting ? 'Creating account...' : 'Create account'}
        </button>
      </form>
      <p className="mt-7 text-center text-sm leading-6 text-stone-500">
        Already have an account?{' '}
        <button type="button" className="text-button" onClick={onLogin} disabled={submitting}>Log in</button>
      </p>
    </AuthCard>
  )
}
