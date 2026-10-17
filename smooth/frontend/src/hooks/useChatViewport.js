import { useEffect } from 'react'
export default function useChatViewport() {
  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return
    const root = document.documentElement
    let frame
    function apply() {
      if (viewport.scale !== 1) return // Preserve browser pinch zoom.
      if (innerWidth < 768) {
        root.style.setProperty('--chat-height', `${viewport.height}px`)
        root.style.setProperty('--chat-offset-top', `${viewport.offsetTop}px`)
      } else {
        root.style.removeProperty('--chat-height')
        root.style.removeProperty('--chat-offset-top')
      }
    }
    function update() { cancelAnimationFrame(frame); frame = requestAnimationFrame(apply) }
    apply()
    viewport.addEventListener('resize', update)
    viewport.addEventListener('scroll', update)
    window.addEventListener('resize', update)
    document.addEventListener('focusin', update); document.addEventListener('focusout', update)
    return () => {
      cancelAnimationFrame(frame)
      viewport.removeEventListener('resize', update); viewport.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
      document.removeEventListener('focusin', update); document.removeEventListener('focusout', update)
      root.style.removeProperty('--chat-height'); root.style.removeProperty('--chat-offset-top')
    }
  }, [])
}
