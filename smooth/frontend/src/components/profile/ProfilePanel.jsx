import { useCallback, useEffect, useRef, useState } from 'react'
import useDialog from '../../hooks/useDialog.js'
import Avatar from '../chat/Avatar.jsx'
import Icon from '../ui/Icon.jsx'
import { ProfileImage, useIdentity } from './IdentityProvider.jsx'
import CropDialog from './CropDialog.jsx'
import { getProfile, saveBiography, uploadPhoto, setPrimaryPhoto, deletePhoto, codePointLength } from '../../services/profiles.js'
import { prepareCropImage, cropErrorMessage } from '../../utils/crop.js'

export function BiographyEditor({ biography, onClose, onSave }) {
  const ref = useRef(null), pending = useRef(false)
  const [text, setText] = useState(biography), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const close = useCallback(() => { if (!pending.current) onClose() }, [onClose])
  useDialog(ref, close)
  const length = codePointLength(text)
  async function save(event) {
    event.preventDefault()
    if (pending.current || length > 1000) return
    pending.current = true; setBusy(true); setError('')
    try { await onSave(text); onClose() }
    catch (error) { setError(error.displayMessage || 'Unable to save your bio.') }
    finally { pending.current = false; setBusy(false) }
  }
  return <div className="identity-overlay"><section ref={ref} role="dialog" aria-modal="true" aria-labelledby="bio-title" className="bio-dialog">
    <header className="identity-toolbar"><button type="button" onClick={close} disabled={busy}>Cancel</button><h2 id="bio-title">Edit bio</h2><button type="submit" form="bio-form" className="text-button" disabled={busy || length>1000}>{busy ? 'Saving…' : 'Save'}</button></header>
    <form id="bio-form" onSubmit={save} aria-busy={busy}><label htmlFor="profile-bio" className="sr-only">Biography</label><textarea id="profile-bio" dir="auto" value={text} onChange={event => setText(event.target.value)} disabled={busy} rows="7" aria-describedby="bio-counter" aria-invalid={length>1000} placeholder="A little about you…" />
      <div className="bio-meta"><button type="button" className="text-button" disabled={busy || !text} onClick={() => setText('')}>Clear bio</button><span id="bio-counter" data-invalid={length>1000}>{length} / 1000</span></div>
      {length>1000 && <p role="alert" className="form-error">Use up to 1000 characters.</p>}{error && <p role="alert" className="form-error">{error}</p>}
    </form>
  </section></div>
}

function DeleteConfirmation({ onClose, onConfirm }) {
  const ref = useRef(null), pending = useRef(false)
  const [busy,setBusy] = useState(false), [error,setError] = useState('')
  const close = useCallback(() => { if (!pending.current) onClose() }, [onClose])
  useDialog(ref,close)
  return <div className="identity-overlay"><section ref={ref} role="dialog" aria-modal="true" aria-labelledby="delete-photo-title" className="photo-confirm">
    <h2 id="delete-photo-title">Delete this photo?</h2><p>This photo will be removed from your profile.</p>
    {error && <p role="alert" className="form-error">{error}</p>}<div><button type="button" onClick={close} disabled={busy}>Keep photo</button><button type="button" className="danger-button" disabled={busy} onClick={async () => {
      if (pending.current) return; pending.current = true; setBusy(true)
      try { await onConfirm(); onClose() } catch(error) { setError(error.displayMessage || 'Unable to delete photo.') }
      finally { pending.current = false; setBusy(false) }
    }}>{busy ? 'Deleting…' : 'Delete photo'}</button></div>
  </section></div>
}

export function PhotoGallery({ profile, onSelected }) {
  const ref = useRef(null)
  const [index, setIndex] = useState(0)
  useEffect(() => {
    const primary = Math.max(0,profile.photos.findIndex(p => p.id===profile.primary_photo_id))
    setIndex(primary)
    if (ref.current) ref.current.scrollLeft = primary * ref.current.clientWidth
    onSelected?.(profile.photos[primary]?.id)
  }, [profile.primary_photo_id, profile.photos, onSelected])
  const move = next => ref.current?.scrollTo({left:Math.max(0,Math.min(profile.photos.length-1,next))*ref.current.clientWidth,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'})
  if (!profile.photos.length) return <div className="gallery-empty"><Avatar user={profile} presence={false} size="large" /><p>No profile photos yet.</p></div>
  return <div className="photo-gallery">
    <div ref={ref} className="gallery-track" tabIndex="0" role="region" aria-label="Profile photos" onKeyDown={event => {
      if (['ArrowLeft','ArrowRight'].includes(event.key)) { event.preventDefault(); move(index+(event.key==='ArrowRight'?1:-1)) }
    }} onScroll={event => { const next = Math.round(event.currentTarget.scrollLeft/event.currentTarget.clientWidth); if (next!==index) { setIndex(next); onSelected?.(profile.photos[next]?.id) } }}>
      {profile.photos.map((photo,i) => <ProfileImage key={photo.id} photoId={photo.id} alt={`Profile photo ${i+1} of ${profile.photos.length}`} />)}
    </div>
    {profile.photos.length>1 && <div className="gallery-pagination"><button type="button" aria-label="Previous photo" disabled={index===0} onClick={() => move(index-1)}>‹</button><span role="status">{index+1} / {profile.photos.length}</span><button type="button" aria-label="Next photo" disabled={index===profile.photos.length-1} onClick={() => move(index+1)}>›</button></div>}
  </div>
}

export function useProfile(id, fallback) {
  const identity = useIdentity()
  const token = identity?.token
  const [profile,setProfile] = useState(null), [error,setError] = useState(''), [attempt,setAttempt] = useState(0)
  useEffect(() => {
    if (!token) return
    const controller = new AbortController()
    setError(''); setProfile(null)
    getProfile(token,id,controller.signal).then(profile => {
      if (!controller.signal.aborted) { setProfile(profile); identity.update(profile) }
    }).catch(error => { if (controller.signal.aborted) return; if (error.status===401) identity.onUnauthorized(); else setError(error.displayMessage || 'Unable to load profile.') })
    return () => controller.abort()
  }, [token,id,attempt,identity?.update,identity?.onUnauthorized])
  const update = useCallback(profile => { setProfile(profile); identity?.update(profile) }, [identity?.update])
  return { profile, display:profile || fallback, update, error, retry:() => setAttempt(v => v+1) }
}

export function ProfileSurface({ user, own = false, online = false, lastSeen, onClose, onChat, onUpdated }) {
  const ref = useRef(null)
  useDialog(ref,onClose)
  const identity = useIdentity()
  const state = useProfile(own ? 'me' : user.id,user)
  const [selected,setSelected] = useState(null), [menu,setMenu] = useState(false), [deleting,setDeleting] = useState(false)
  const [crop,setCrop] = useState(null), [busy,setBusy] = useState(false), [error,setError] = useState('')
  const [editing,setEditing] = useState(false)
  const input = useRef(null), pending = useRef(false), alive = useRef(true), imageRef = useRef(null), loading = useRef(null)
  useEffect(() => { alive.current=true; return () => { alive.current=false; loading.current?.abort(); imageRef.current?.dispose() } }, [])
  const closeCrop = useCallback(() => { imageRef.current?.dispose(); imageRef.current=null; setCrop(null) }, [])
  const closeEdit = useCallback(() => setEditing(false),[]), closeDelete = useCallback(() => setDeleting(false),[])
  function update(profile) { state.update(profile); onUpdated?.(profile); setMenu(false) }
  const profile=state.profile
  async function selectFile(event) {
    const element=event.currentTarget, file=element.files?.[0]
    if (!file || pending.current) return
    const controller = new AbortController(); loading.current=controller
    pending.current=true;setBusy(true);setError('')
    try {
      const prepared=await prepareCropImage(file,{signal:controller.signal,onRead:() => {element.value=''}})
      if(!alive.current) {prepared.dispose();return}
      imageRef.current?.dispose(); imageRef.current=prepared;setCrop(prepared)
    }
    catch(error) { if(alive.current && error.name!=='AbortError') setError(cropErrorMessage(error)) }
    finally { element.value=''; loading.current=null; pending.current=false;if(alive.current)setBusy(false) }
  }
  return <div className="identity-overlay"><section ref={ref} role="dialog" aria-modal="true" aria-labelledby="profile-view-title" className="profile-dialog">
    <header className="identity-toolbar"><button type="button" onClick={onClose} aria-label="Close profile"><Icon name="back" /></button><h2 id="profile-view-title">{own?'Your photos':'Profile'}</h2>{own && profile && <button type="button" aria-label="Photo options" onClick={() => setMenu(v => !v)} disabled={busy}>•••</button>}</header>
    <div className="profile-dialog-scroll">
      {profile ? <PhotoGallery profile={profile} onSelected={setSelected} /> : <Avatar user={user} presence={false} size="large" />}
      {own && profile && <><input ref={input} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" aria-label="Choose profile photo" onChange={selectFile} disabled={busy} />
        {menu && <div className="photo-options">{selected && selected!==profile.primary_photo_id && <button type="button" disabled={busy} onClick={async () => { if(pending.current)return; pending.current=true;setBusy(true);setError('');try{update(await identity.guard(setPrimaryPhoto(identity.token,selected)))}catch(e){setError(e.displayMessage)}finally{pending.current=false;setBusy(false)} }}>Set as primary</button>}{selected && <button type="button" className="danger-button" disabled={busy} onClick={() => {setMenu(false);setDeleting(true)}}>Delete this photo</button>}</div>}
        <button type="button" className="profile-add" onClick={() => input.current.click()} disabled={busy || profile.photos.length>=profile.max_photos}>{busy ? 'Opening photo…' : `Add photo · ${profile.photos.length}/${profile.max_photos}`}</button></>}
      <div className="profile-details"><h3 dir="auto">@{user.username}</h3>{!own && <p className="profile-hint">{online?'online':lastSeen?'Last seen '+new Date(lastSeen).toLocaleString():'offline'}</p>}
        {profile && <p dir="auto" className="profile-biography">{profile.biography || (own?'Add a few words about yourself.':'No bio yet.')}</p>}
        {!profile && !state.error && <p role="status" className="profile-hint">Loading profile…</p>}
        {state.error && <p role="alert">{state.error} <button type="button" className="text-button" onClick={state.retry}>Retry</button></p>}
        {own && profile && <button type="button" className="text-button" onClick={() => setEditing(true)}>Edit bio</button>}
        {!own && <button type="button" className="primary-button profile-chat-action" onClick={() => {
          // Let the dialog's Back entry settle before creating a conversation
          // entry, so Android Back returns to the original destination once.
          if (matchMedia('(max-width: 767px)').matches && history.state?.smoothOverlay) {
            window.addEventListener('popstate',() => onChat(user),{once:true});onClose()
          } else {onClose();onChat(user)}
        }}>Open conversation</button>}
        {error && <p role="alert" className="form-error">{error}</p>}
      </div>
    </div>
    {crop && <CropDialog image={crop} onClose={closeCrop} onSave={async blob => {update(await identity.guard(uploadPhoto(identity.token,blob)));closeCrop()}} />}
    {editing && <BiographyEditor biography={profile.biography} onClose={closeEdit} onSave={async text => update(await identity.guard(saveBiography(identity.token,text)))} />}
    {deleting && <DeleteConfirmation onClose={closeDelete} onConfirm={async () => update(await identity.guard(deletePhoto(identity.token,selected)))} />}
  </section></div>
}
