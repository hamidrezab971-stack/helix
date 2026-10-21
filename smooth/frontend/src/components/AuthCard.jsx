export function AuthCard({ title, description, children }) {
  return (
    <section aria-labelledby="auth-title" className="auth-card">
      <h1 id="auth-title" className="auth-title">
        {title}
      </h1>
      <p className="auth-description">{description}</p>
      <div className="mt-8">{children}</div>
    </section>
  )
}

export function FormField({ id, label, hint, error, ...inputProps }) {
  const description = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ')

  return (
    <div>
      <label htmlFor={id} className="field-label">{label}</label>
      <input
        id={id}
        name={id}
        className="auth-input"
        aria-invalid={Boolean(error)}
        aria-describedby={description || undefined}
        {...inputProps}
      />
      {hint && <p id={`${id}-hint`} className="field-hint">{hint}</p>}
      {error && <p id={`${id}-error`} role="alert" className="field-error">{error}</p>}
    </div>
  )
}
