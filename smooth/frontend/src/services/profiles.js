import { request } from './api.js'

export const codePointLength = text => Array.from(text.replace(/\r\n?/g, '\n')).length
export const normalizeBiography = text => text.replace(/\r\n?/g, '\n')

export function mergeProfileSummaries(previous, profile) {
  const old = previous[profile.id], version = profile.profile_version || 0
  if (old && (old.profile_version > version || (old.profile_version === version && old.primary_photo_id === profile.primary_photo_id))) return previous
  return Object.fromEntries([
    ...Object.entries(previous).filter(([id]) => id!==String(profile.id)).slice(-127),
    [profile.id, { primary_photo_id: profile.primary_photo_id, profile_version: version }],
  ])
}

export function getProfile(token, id = 'me', signal) {
  return request(`/api/profiles/${id}`, { token, signal })
}
export function saveBiography(token, biography, signal) {
  return request('/api/profiles/me', { token, signal, method: 'PATCH', body: { biography: normalizeBiography(biography) } })
}
export function uploadPhoto(token, blob, signal) {
  const body = new FormData()
  body.append('file', blob, 'profile.webp')
  return request('/api/profiles/me/photos', { token, signal, body })
}
export function setPrimaryPhoto(token, id, signal) {
  return request(`/api/profiles/me/photos/${id}/primary`, { token, signal, method: 'PATCH' })
}
export function deletePhoto(token, id, signal) {
  return request(`/api/profiles/me/photos/${id}`, { token, signal, method: 'DELETE' })
}

// Per-session, bounded shared blob cache. Active subscribers share one fetch;
// idle LRU entries are revoked on eviction and all entries on logout.
export function createPhotoCache(token, unauthorized, environment = {}) {
  const get = environment.get || ((id, signal) => request(`/api/profiles/photos/${id}/content`, { token, signal, binary: true }))
  const urls = environment.urls || URL
  const entries = new Map()
  const max = 64
  function discard(id, entry) { entry.controller.abort(); if (entry.url) urls.revokeObjectURL(entry.url); entries.delete(id) }
  return {
    acquire(id, notify) {
      let entry = entries.get(id)
      if (!entry) {
        if (entries.size >= max) {
          const idle = [...entries].find(([, e]) => e.listeners.size === 0)
          if (idle) discard(...idle)
          else { notify(null); return () => {} }
        }
        entry = { listeners: new Set(), controller: new AbortController(), url: null }
        entries.set(id, entry)
        get(id, entry.controller.signal).then(blob => {
          if (entry.controller.signal.aborted) return
          entry.url = urls.createObjectURL(blob)
          for (const listener of entry.listeners) listener(entry.url)
        }).catch(error => {
          if (error.status === 401) unauthorized?.()
          if (!entry.controller.signal.aborted) for (const listener of entry.listeners) listener(null)
          if (entries.get(id) === entry) discard(id, entry)
        })
      }
      // Updating Map insertion order implements LRU without timers.
      entries.delete(id); entries.set(id, entry)
      entry.listeners.add(notify)
      notify(entry.url)
      return () => {
        entry.listeners.delete(notify)
        if (!entry.listeners.size && !entry.url && entries.get(id)===entry) discard(id,entry)
      }
    },
    dispose() { for (const [id, entry] of entries) discard(id, entry) },
    get size() { return entries.size },
  }
}
