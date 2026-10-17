import { useEffect, useRef, useState } from 'react'
import { API_URL } from '../services/api.js'

// Dynamic import keeps the official local widget out of the messaging bundle.
export default function Captcha({ purpose, onSolution, resetKey }) {
  const host = useRef(null)
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState('loading')
  const callback = useRef(onSolution)
  callback.current = onSolution
  useEffect(() => {
    let active = true, widget, timer
    callback.current('')
    setState('loading')
    import('../vendor/altcha.js').then(() => {
      if (!active) return
      widget = document.createElement('altcha-widget')
      widget.setAttribute('challenge', `${API_URL}/api/auth/challenge?purpose=${purpose}`)
      widget.setAttribute('auto', 'onfocus')
      widget.setAttribute('theme', 'dark')
      widget.setAttribute('workers', '2')
      widget.setAttribute('aria-label', 'Security verification')
      widget.addEventListener('statechange', event => {
        if (!active) return
        const next = event.detail.state
        setState(next)
        callback.current(next === 'verified' ? event.detail.payload || '' : '')
        clearTimeout(timer)
        if (next === 'verified') timer = setTimeout(() => {
          if (active) { callback.current(''); setState('expired'); widget.reset() }
        }, 240000)
      })
      host.current.replaceChildren(widget)
      setState('unverified')
    }).catch(() => { if (active) setState('error') })
    return () => { active = false; clearTimeout(timer); widget?.remove() }
  }, [purpose, resetKey, attempt])
  return <div className="captcha-area">
    <div ref={host} />
    <span role="status" aria-live="polite" className="captcha-status">{({ loading:'Loading verification…', unverified:'Verify before continuing.', verifying:'Verifying this device…', verified:'Verification ready.', expired:'Verification expired. Please retry.', error:'Unable to verify. Check your connection and retry.' })[state]}</span>
    {['error', 'expired'].includes(state) && <button type="button" className="text-button" onClick={() => setAttempt(v => v+1)}>Retry verification</button>}
  </div>
}
