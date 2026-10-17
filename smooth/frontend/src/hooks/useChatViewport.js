import { useEffect } from 'react'
export default function useChatViewport() {
  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return
    const root = document.documentElement
    function update() {
      const keyboard = innerWidth < 768 && viewport.scale === 1 && document.activeElement?.matches('textarea, input') && viewport.height < innerHeight - 80
      if (keyboard) root.style.setProperty('--chat-height', `${viewport.height}px`)
      else root.style.removeProperty('--chat-height')
    }
    viewport.addEventListener('resize', update)
    document.addEventListener('focusin', update); document.addEventListener('focusout', update)
    return () => { viewport.removeEventListener('resize', update); document.removeEventListener('focusin', update); document.removeEventListener('focusout', update); root.style.removeProperty('--chat-height') }
  }, [])
}
