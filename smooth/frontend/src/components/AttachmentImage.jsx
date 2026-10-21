import { useEffect, useRef, useState } from 'react'
import { getAttachmentBlob } from '../services/api.js'

// A small in-memory blob LRU avoids repeated downloads when revisiting nearby
// history. URLs belong to visible components and are always revoked there.
const cache = new Map()
let bytes = 0
let epoch = 0
export function clearAttachmentCache() { epoch++; cache.clear(); bytes = 0 }
function remember(key, blob) {
  if (cache.has(key)) bytes -= cache.get(key).size
  cache.delete(key); cache.set(key, blob); bytes += blob.size
  while (cache.size > 12 || bytes > 24 * 1024 * 1024) {
    const oldest = cache.keys().next().value
    bytes -= cache.get(oldest).size; cache.delete(oldest)
  }
}

export default function AttachmentImage({ attachment, token, onUnauthorized, onOpen }) {
  const element = useRef(null)
  const [near, setNear] = useState(false)
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [decoded, setDecoded] = useState(false)
  const scale = Math.min(1, 320 / attachment.width, 360 / attachment.height)

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
    setDecoded(false)
    async function load() {
      try {
        const blob = await attachmentBlob(token, attachment.id, controller.signal)
        if (!active) return
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

  return <span ref={element} data-attachment-placeholder={attachment.id} className="message-media relative block max-w-full overflow-hidden bg-black/5"
    style={{ width: attachment.width * scale, aspectRatio: `${attachment.width} / ${attachment.height}` }}>
    {error ? <span className="media-status">{error} <button type="button" className="text-button" onClick={() => { setUrl(''); setAttempt(value => value + 1) }}>Retry image</button></span>
      : url ? <button type="button" className="absolute inset-0 h-full w-full" aria-label="Open photo" onClick={() => onOpen?.(attachment)}><img src={url} alt="Message photo" decoding="async" data-decoded={decoded} onLoad={() => setDecoded(true)} onError={() => setError('Unable to display image.')} data-attachment-id={attachment.id} width={attachment.width} height={attachment.height} className="absolute inset-0 h-full w-full object-contain" /></button>
        : <span role="status" className="media-status">{near ? <><span className="loading-spinner" aria-hidden="true" /><span>Loading image…</span></> : 'Photo'}</span>}
  </span>
}

export async function attachmentBlob(token, id, signal) {
  const started = epoch
  const key = `${token}:${id}`
  const blob = cache.get(key) || await getAttachmentBlob(token, id, signal)
  if (started === epoch && !signal?.aborted) remember(key, blob)
  return blob
}
