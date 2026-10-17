import { useCallback, useEffect, useState } from 'react'
export default function useMessageActions(messages, historyRef) {
  const [target, setTarget] = useState(null)
  const close = useCallback(() => setTarget(null), [])
  const open = useCallback((message, element) => {
    element.focus({ preventScroll: true })
    setTarget({ id: message.id, element, rect: element.getBoundingClientRect() })
  }, [])
  useEffect(() => {
    if (target && !messages.some(message => message.id === target.id)) close()
  }, [messages, target, close])
  useEffect(() => {
    if (!target) return
    const element = historyRef.current
    element?.addEventListener('scroll', close, { passive: true })
    window.addEventListener('resize', close)
    window.visualViewport?.addEventListener('resize', close)
    window.visualViewport?.addEventListener('scroll', close)
    return () => {
      element?.removeEventListener('scroll', close)
      window.removeEventListener('resize', close)
      window.visualViewport?.removeEventListener('resize', close)
      window.visualViewport?.removeEventListener('scroll', close)
    }
  }, [target, close, historyRef])
  return { target, close, open }
}
