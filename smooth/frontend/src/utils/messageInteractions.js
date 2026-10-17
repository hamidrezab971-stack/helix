// Pure geometry shared by the menu and its boundary regression tests.
export function positionMessageMenu(anchor, menu, viewport) {
  const gutter = 12, gap = 8
  const width = Math.max(0, viewport.width - gutter * 2)
  const maxHeight = Math.max(0, viewport.height - gutter * 2)
  const menuWidth = Math.min(width, menu.width), menuHeight = Math.min(maxHeight, menu.height)
  const minX = (viewport.left || 0) + gutter, minY = (viewport.top || 0) + gutter
  const maxX = minX + width - menuWidth, maxY = minY + maxHeight - menuHeight
  const above = anchor.top - menuHeight - gap
  const below = anchor.bottom + gap
  const top = above >= minY ? above : below <= maxY ? below : maxY
  return { left: Math.max(minX, Math.min(maxX, anchor.left)), top: Math.max(minY, Math.min(maxY, top)), maxHeight, maxWidth: width }
}

export function shouldSendOnEnter(event, touchInput) {
  return event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229 && !touchInput
}

export function movedBeyondTap(origin, point) {
  return Math.hypot(point.x - origin.x, point.y - origin.y) > 10
}
