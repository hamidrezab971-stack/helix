import { useCallback, useEffect, useState } from 'react'
export default function useMessageActions(messages, historyRef) {
  const [target, setTarget] = useState(null)
  const close = useCallback(() => setTarget(null), [])
  const open = useCallback((message, element) => {
    element.focus({ preventScroll: true })
    const history = historyRef.current
    setTarget({ id: message.id, element, rect: element.getBoundingClientRect(),
      scrollTop: history?.scrollTop, scrollLeft: history?.scrollLeft })
  }, [historyRef])
  useEffect(() => {
    if (target && !messages.some(message => message.id === target.id)) close()
  }, [messages, target, close])
  useEffect(() => {
    if (!target) return
    const element = historyRef.current
    // Focusing a bubble can scroll it into view before open(). Chromium may
    // deliver that queued notification after the menu mounts. Dismiss only
    // when the history has moved since opening, not for that stale event.
    const moved = () => {
      if (element.scrollTop !== target.scrollTop || element.scrollLeft !== target.scrollLeft) close()
    }
    element?.addEventListener('scroll', moved, { passive: true })
    window.addEventListener('resize', close)
    window.visualViewport?.addEventListener('resize', close)
    window.visualViewport?.addEventListener('scroll', close)
    return () => {
      element?.removeEventListener('scroll', moved)
      window.removeEventListener('resize', close)
      window.visualViewport?.removeEventListener('resize', close)
      window.visualViewport?.removeEventListener('scroll', close)
    }
  }, [target, close, historyRef])
  return { target, close, open }
}
