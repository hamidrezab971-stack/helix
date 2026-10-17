import { useState } from 'react'
import { useIdentity, usePhoto } from '../profile/IdentityProvider.jsx'

export default function Avatar({ name = '', user, online = false, size = '', presence = true }) {
  name = user?.username || name
  const identity = useIdentity()
  const override = identity?.profiles[user?.id]
  const photo = override && override.profile_version >= (user?.profile_version || 0) ? override.primary_photo_id : user?.primary_photo_id
  const { ref, url } = usePhoto(photo)
  const [failed, setFailed] = useState(null)
  let hash = 0
  for (const character of name) hash = (hash * 31 + character.codePointAt(0)) >>> 0
  return <span ref={ref} className={`chat-avatar ${size}`} data-tone={hash % 5} aria-hidden="true">
    {(!url || failed === url) && (Array.from(name)[0]?.toUpperCase() || '?')}
    {url && failed !== url && <img src={url} alt="" decoding="async" onError={() => setFailed(url)} />}
    {presence && <span className="avatar-presence" data-online={online} />}
  </span>
}
