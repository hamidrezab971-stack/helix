// No pointer capture: the browser keeps native vertical scrolling.
export function conversationGesture(open, { delay = 480, schedule = setTimeout, unschedule = clearTimeout } = {}) {
  let start = null, timer = null, suppressed = false, opened = false
  const cancel = () => { unschedule(timer); timer = null; start = null }
  return {
    cancel,
    down(event) {
      cancel()
      if (!event.isPrimary) { suppressed = true; return }
      suppressed = opened = false
      if (event.button > 0 || !['touch', 'pen'].includes(event.pointerType)) return
      start = { x: event.clientX, y: event.clientY, id: event.pointerId }
      const element = event.currentTarget
      timer = schedule(() => { suppressed = opened = true; cancel(); open(element) }, delay)
    },
    move(event) {
      if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) { suppressed = true; cancel() }
    },
    up() { cancel() },
    interrupt() { suppressed = true; cancel() },
    click(event) {
      cancel()
      if (suppressed && event.detail !== 0) { event.preventDefault(); event.stopPropagation(); suppressed = false; return false }
      suppressed = false
      return true
    },
    context(event) {
      event.preventDefault(); cancel()
      if (!opened) open(event.currentTarget)
      suppressed = opened = true
    },
  }
}
