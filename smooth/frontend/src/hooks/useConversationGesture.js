import { useEffect, useRef } from 'react'
import { conversationGesture } from '../utils/conversationGesture.js'

export default function useConversationGesture(onOpen) {
  const latest = useRef(onOpen); latest.current = onOpen
  const controller = useRef(null)
  if (!controller.current) controller.current = conversationGesture(element => latest.current(element))
  useEffect(() => {
    const gesture = controller.current
    const visibility = () => { if (document.visibilityState !== 'visible') gesture.interrupt() }
    const secondPointer = event => { if (!event.isPrimary) gesture.interrupt() }
    document.addEventListener('scroll', gesture.interrupt, true)
    document.addEventListener('pointerdown', secondPointer, true)
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('blur', gesture.interrupt)
    return () => {
      gesture.cancel()
      document.removeEventListener('scroll', gesture.interrupt, true)
      document.removeEventListener('pointerdown', secondPointer, true)
      document.removeEventListener('visibilitychange', visibility)
      window.removeEventListener('blur', gesture.interrupt)
    }
  }, [])
  const gesture = controller.current
  return { onPointerDown: gesture.down, onPointerMove: gesture.move, onPointerUp: gesture.up,
    onPointerCancel: gesture.interrupt, onContextMenu: gesture.context, onClickCapture: gesture.click }
}
