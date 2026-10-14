import { useEffect, useRef, useState } from 'react'
import { getAttachmentBlob } from '../services/api.js'

// A small in-memory blob LRU avoids repeated downloads when revisiting nearby
// history. URLs belong to visible components and are always revoked there.
const cache = new Map()
let bytes = 0
function remember(key, blob) {
  if (cache.has(key)) bytes -= cache.get(key).size
  cache.delete(key); cache.set(key, blob); bytes += blob.size
  while (cache.size > 12 || bytes > 24 * 1024 * 1024) {
    const oldest = cache.keys().next().value
    bytes -= cache.get(oldest).size; cache.delete(oldest)
  }
}

export default function AttachmentImage({ attachment, token, onUnauthorized }) {
  const element = useRef(null)
  const [near, setNear] = useState(false)
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const scale = Math.min(1, 240 / attachment.width, 288 / attachment.height)

  useEffect(() => {
    const observer = new IntersectionObserver(entries => setNear(entries[0].isIntersecting), {
      root: element.current?.closest('.chat-history'), rootMargin: '160px',
    })
    observer.observe(element.current)
    return () => observer.disconnect()
  }, [attachment.id])

  useEffect(() => {
    if (!near) { setUrl(''); return }
    const controller = new AbortController()
    let active = true
    let objectUrl
    setError('')
    async function load() {
      try {
        const key = `${token}:${attachment.id}`
        const cached = cache.get(key)
        const blob = cached || await getAttachmentBlob(token, attachment.id, controller.signal)
        if (!active) return
        remember(key, blob)
        objectUrl = URL.createObjectURL(blob)
        setUrl(objectUrl)
      } catch (error) {
        if (!active || error.name === 'AbortError') return
        if (error.status === 401) onUnauthorized()
        else setError('Unable to load image.')
      }
    }
    load()
    return () => {
      active = false
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [near, token, attachment.id, attempt, onUnauthorized])

  return <span ref={element} data-attachment-placeholder={attachment.id} className="relative mb-2 block max-w-full overflow-hidden rounded-lg bg-black/5"
    style={{ width: attachment.width * scale, aspectRatio: `${attachment.width} / ${attachment.height}` }}>
    {url ? <img src={url} alt="Message photo" data-attachment-id={attachment.id} width={attachment.width} height={attachment.height} className="absolute inset-0 h-full w-full object-contain" />
      : error ? <span className="block text-sm">{error} <button type="button" className="underline" onClick={() => setAttempt(value => value + 1)}>Retry image</button></span>
        : <span role="status" className="text-xs">{near ? 'Loading image...' : 'Photo'}</span>}
  </span>
}
