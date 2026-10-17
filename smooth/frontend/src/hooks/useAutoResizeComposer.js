import { useLayoutEffect, useRef } from 'react'

function resize(element) {
  if (!element) return
  element.style.height = 'auto'
  element.style.height = `${Math.min(134, Math.max(38, element.scrollHeight))}px`
  element.style.overflowY = element.scrollHeight > 134 ? 'auto' : 'hidden'
}
export default function useAutoResizeComposer(value) {
  const ref = useRef(null)
  useLayoutEffect(() => resize(ref.current), [value])
  useLayoutEffect(() => {
    const element = ref.current
    let width = element.clientWidth
    const observer = new ResizeObserver(() => {
      if (element.clientWidth !== width) { width = element.clientWidth; resize(element) }
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return ref
}
