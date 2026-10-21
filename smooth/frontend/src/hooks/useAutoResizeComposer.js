import { useLayoutEffect, useRef } from 'react'

function resize(element, motion) {
  if (!element) return
  const previous = element.getBoundingClientRect().height
  element.style.height = 'auto'
  const limit = Math.min(134, window.innerHeight * .26)
  const height = Math.min(limit, Math.max(44, element.scrollHeight))
  element.style.height = `${height}px`
  element.style.overflowY = element.scrollHeight > height ? 'auto' : 'hidden'
  motion.current?.cancel()
  if (Math.abs(previous - height) > 1 && !matchMedia('(prefers-reduced-motion: reduce)').matches && element.animate) {
    motion.current = element.animate([{ height: `${previous}px` }, { height: `${height}px` }], { duration: 160, easing: 'cubic-bezier(.2,.8,.2,1)' })
  }
}
export default function useAutoResizeComposer(value) {
  const ref = useRef(null)
  const motion = useRef(null)
  useLayoutEffect(() => resize(ref.current, motion), [value])
  useLayoutEffect(() => {
    const element = ref.current
    let width = element.clientWidth
    const observer = new ResizeObserver(() => {
      if (element.clientWidth !== width) { width = element.clientWidth; resize(element, motion) }
    })
    observer.observe(element)
    return () => { observer.disconnect(); motion.current?.cancel() }
  }, [])
  return ref
}
