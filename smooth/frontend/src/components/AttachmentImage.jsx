import { useEffect, useState } from 'react'
import { getAttachmentBlob } from '../services/api.js'

export default function AttachmentImage({ attachment, token, onUnauthorized }) {
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    let objectUrl
    setUrl('')
    setError('')
    async function load() {
      try {
        const blob = await getAttachmentBlob(token, attachment.id, controller.signal)
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
  }, [token, attachment.id, attempt, onUnauthorized])

  return url ? <img src={url} alt="Message photo" data-attachment-id={attachment.id} width={attachment.width} height={attachment.height} className="mb-2 max-h-72 max-w-full rounded-lg object-contain" />
    : error ? <span className="block text-sm">{error} <button type="button" className="underline" onClick={() => setAttempt(value => value + 1)}>Retry image</button></span>
      : <span role="status" className="block text-sm">Loading image...</span>
}
