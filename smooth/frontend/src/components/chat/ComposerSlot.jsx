import { useLayoutEffect, useState } from 'react'

// Keep the last preview while the small composer region collapses. Inert takes
// it out of keyboard/screen-reader interaction immediately.
export default function ComposerSlot({ open, children }) {
  const [content, setContent] = useState(children)
  useLayoutEffect(() => {
    if (open) { setContent(children); return }
    const timer = setTimeout(() => setContent(null), matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 220)
    return () => clearTimeout(timer)
  }, [open, children])
  return <div className="composer-slot" data-open={Boolean(open)} aria-hidden={!open} inert={!open}>
    <div className="composer-slot-content">{content}</div>
  </div>
}
