import { useCallback, useEffect, useState } from 'react'
export default function useMessageActions(messages, historyRef) {
  const [target, setTarget] = useState(null)
  const close = useCallback(() => setTarget(null), [])
  useEffect(() => {
    if (target && !messages.some(message => message.id === target.id)) close()
  }, [messages, target, close])
  useEffect(() => {
    if (!target) return
    const element = historyRef.current
    element?.addEventListener('scroll', close, { passive: true })
    window.addEventListener('resize', close)
    window.visualViewport?.addEventListener('resize', close)
    return () => {
      element?.removeEventListener('scroll', close)
      window.removeEventListener('resize', close)
      window.visualViewport?.removeEventListener('resize', close)
    }
  }, [target, close, historyRef])
  return { target, close, open: (message, element) => setTarget({ id: message.id, element, rect: element.getBoundingClientRect() }) }
}
