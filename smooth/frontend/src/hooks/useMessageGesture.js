import { useEffect, useRef } from 'react'
import { movedBeyondTap } from '../utils/messageInteractions.js'

export default function useMessageGesture(message, onOpen) {
  const gesture = useRef(null), timer = useRef(null), suppressClick = useRef(false)
  useEffect(() => () => clearTimeout(timer.current), [])
  function cancel() { clearTimeout(timer.current); gesture.current = null }
  return {
    onPointerDown(event) {
      suppressClick.current = false
      if (event.pointerType !== 'touch' || !event.isPrimary || event.target.closest('button, a')) return
      const element = event.currentTarget
      gesture.current = { x: event.clientX, y: event.clientY }
      timer.current = setTimeout(() => {
        suppressClick.current = true
        gesture.current = null
        onOpen(message, element)
      }, 450)
    },
    onPointerMove(event) {
      if (gesture.current && movedBeyondTap(gesture.current, { x: event.clientX, y: event.clientY })) { suppressClick.current = true; cancel() }
    },
    onPointerUp() { cancel() },
    onPointerCancel() { suppressClick.current = true; cancel() },
    onClick(event) {
      cancel()
      if (suppressClick.current) { suppressClick.current = false; return }
      if (event.target.closest('button, a') || window.getSelection()?.toString()) return
      onOpen(message, event.currentTarget)
    },
    onContextMenu(event) {
      if (event.target.closest('button, a') || window.getSelection()?.toString()) return
      event.preventDefault()
      cancel()
      if (!suppressClick.current) onOpen(message, event.currentTarget)
      suppressClick.current = true
    },
  }
}
