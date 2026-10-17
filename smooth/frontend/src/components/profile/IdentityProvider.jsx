import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { createPhotoCache, mergeProfileSummaries } from '../../services/profiles.js'

const IdentityContext = createContext(null)
export function IdentityProvider({ token, onUnauthorized, children }) {
  const [profiles, setProfiles] = useState({})
  const cache = useMemo(() => createPhotoCache(token, onUnauthorized), [token, onUnauthorized])
  useEffect(() => () => cache.dispose(), [cache])
  const update = useCallback(profile => setProfiles(previous => mergeProfileSummaries(previous,profile)), [])
  const guard = useCallback(async operation => {
    try { return await operation } catch(error) { if(error.status===401) onUnauthorized(); throw error }
  },[onUnauthorized])
  const value = useMemo(() => ({ token, profiles, update, cache, guard, onUnauthorized }), [token, profiles, update, cache, guard, onUnauthorized])
  return <IdentityContext.Provider value={value}>{children}</IdentityContext.Provider>
}
export const useIdentity = () => useContext(IdentityContext)

export function usePhoto(photoId) {
  const identity = useIdentity()
  const ref = useRef(null)
  const [url, setURL] = useState(null)
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    if (!ref.current || !globalThis.IntersectionObserver) { setVisible(true); return }
    const observer = new IntersectionObserver(entries => {
      setVisible(entries.some(entry => entry.isIntersecting))
    }, { rootMargin: '160px' })
    observer.observe(ref.current)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    setURL(null)
    if (visible && photoId && identity?.cache) return identity.cache.acquire(photoId, setURL)
  }, [identity?.cache, photoId, visible])
  return { ref, url }
}

export function ProfileImage({ photoId, alt = '', className = '' }) {
  const { ref, url } = usePhoto(photoId)
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [url])
  return <div ref={ref} className={`profile-image ${className}`}>
    {url && !failed ? <img src={url} alt={alt} decoding="async" onError={() => setFailed(true)} /> : <span role="img" aria-label={alt || 'Photo loading'} className="photo-placeholder">{failed ? 'Photo unavailable' : '·'}</span>}
  </div>
}
