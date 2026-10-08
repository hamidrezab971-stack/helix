export function AuthCard({ title, description, children }) {
  return (
    <section aria-labelledby="auth-title" className="w-full max-w-md rounded-3xl border border-stone-200/80 bg-white p-7 shadow-[0_16px_64px_-32px_rgba(56,40,25,0.2)] sm:p-10">
      <h1 id="auth-title" className="break-words text-3xl font-semibold tracking-tight text-stone-900">
        {title}
      </h1>
      <p className="mt-3 text-sm leading-6 text-stone-500">{description}</p>
      <div className="mt-8">{children}</div>
    </section>
  )
}

export function FormField({ id, label, hint, error, ...inputProps }) {
  const description = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ')

  return (
    <div>
      <label htmlFor={id} className="text-sm font-medium text-stone-800">{label}</label>
      <input
        id={id}
        name={id}
        className="auth-input"
        aria-invalid={Boolean(error)}
        aria-describedby={description || undefined}
        {...inputProps}
      />
      {hint && <p id={`${id}-hint`} className="mt-2 text-xs leading-5 text-stone-500">{hint}</p>}
      {error && <p id={`${id}-error`} role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
    </div>
  )
}
