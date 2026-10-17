import { useEffect } from 'react'

// All dialogs use the same focus, Escape and mobile browser-back contract.
export default function useDialog(ref, onClose) {
  useEffect(() => {
    const previous = document.activeElement
    const modal = ref.current
    const focusable = () => [...modal.querySelectorAll('button:not(:disabled), [href], textarea, [tabindex="0"]')]
    focusable()[0]?.focus({ preventScroll: true })
    const mobile = matchMedia('(max-width: 767px)').matches
    const marker = crypto.randomUUID()
    let pushed = false
    const timer = mobile ? setTimeout(() => { history.pushState({ ...history.state, smoothOverlay: marker }, ''); pushed = true }, 0) : null
    let popped = false
    function pop() { if (pushed && history.state?.smoothOverlay !== marker) { popped = true; onClose() } }
    function key(event) {
      if (event.key === 'Escape') { event.preventDefault(); onClose() }
      const items = focusable()
      if (event.key === 'Tab' && items.length) {
        const first = items[0], last = items.at(-1)
        if (event.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement))) { event.preventDefault(); last.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
      }
      if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
        event.preventDefault()
        const i = items.indexOf(document.activeElement)
        items[(i + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
      }
    }
    document.addEventListener('keydown', key)
    if (mobile) window.addEventListener('popstate', pop)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('keydown', key)
      window.removeEventListener('popstate', pop)
      if (mobile && pushed && !popped && history.state?.smoothOverlay === marker) history.back()
      if (previous?.isConnected && (modal.contains(document.activeElement) || document.activeElement === document.body)) previous.focus({ preventScroll: true })
    }
  }, [ref, onClose])
}
