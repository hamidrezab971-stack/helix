import { useLayoutEffect, useRef } from 'react'

export default function useAutoResizeComposer(value) {
  const ref = useRef(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(132, Math.max(36, element.scrollHeight))}px`
    element.style.overflowY = element.scrollHeight > 132 ? 'auto' : 'hidden'
  }, [value])
  return ref
}
