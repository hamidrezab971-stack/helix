import Avatar from '../chat/Avatar.jsx'
import Icon from '../ui/Icon.jsx'
import { utcDate } from '../../utils/formatLastSeen.js'
import { useCallback, useEffect, useRef, useState } from 'react'
import { BiographyEditor, ProfileSurface, useProfile } from '../profile/ProfilePanel.jsx'
import { useIdentity } from '../profile/IdentityProvider.jsx'
import { saveBiography, uploadPhoto } from '../../services/profiles.js'
import { prepareCropImage } from '../../utils/crop.js'
import CropDialog from '../profile/CropDialog.jsx'

export function ProfilePage({ user, onLogout }) {
  const created = utcDate(user.created_at)
  const identity = useIdentity()
  const state = useProfile('me',user)
  const [photos,setPhotos]=useState(false),[editing,setEditing]=useState(false)
  const [crop,setCrop]=useState(null),[opening,setOpening]=useState(false),[photoError,setPhotoError]=useState('')
  const input=useRef(null),pending=useRef(false),alive=useRef(true),imageRef=useRef(null)
  useEffect(() => {alive.current=true;return () => {alive.current=false;if(imageRef.current)URL.revokeObjectURL(imageRef.current.url)}},[])
  const closeCrop=useCallback(() => {if(imageRef.current)URL.revokeObjectURL(imageRef.current.url);imageRef.current=null;setCrop(null)},[])
  async function choosePhoto(event) {
    const file=event.target.files?.[0];event.target.value=''
    if(!file || pending.current)return
    pending.current=true;setOpening(true);setPhotoError('')
    try {const image=await prepareCropImage(file);if(!alive.current){URL.revokeObjectURL(image.url);return}imageRef.current=image;setCrop(image)}
    catch(error){if(alive.current)setPhotoError(error.message)}
    finally {pending.current=false;if(alive.current)setOpening(false)}
  }
  const closePhotos=useCallback(() => setPhotos(false),[]),closeEdit=useCallback(() => setEditing(false),[])
  return <section aria-label="Your profile" className="account-page navigation-surface">
    <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" aria-label="Add profile photo" onChange={choosePhoto} disabled={opening} />
    <button type="button" className="profile-avatar-button" aria-label="Add profile photo" disabled={opening || (state.profile && state.profile.photos.length>=state.profile.max_photos)} onClick={() => input.current.click()}><Avatar user={state.display} presence={false} size="large" /><span className="avatar-add" aria-hidden="true">+</span></button>
    <h2 dir="auto">@{user.username}</h2>
    <button type="button" className="text-button profile-manage" onClick={() => setPhotos(true)}>Manage photos</button>
    {opening && <p role="status" className="profile-hint">Opening photo…</p>}{photoError && <p role="alert" className="form-error">{photoError}</p>}
    {state.profile && <div className="profile-bio-section"><p className="settings-label">Bio</p><p dir="auto" className="profile-biography">{state.profile.biography || 'A little about you…'}</p><button type="button" className="text-button" onClick={() => setEditing(true)}>Edit bio</button></div>}
    {!state.profile && identity && !state.error && <p role="status" className="profile-hint">Loading profile…</p>}
    {state.error && <p role="alert">{state.error} <button type="button" className="text-button" onClick={state.retry}>Retry</button></p>}
    <dl><dt>Username</dt><dd dir="auto">@{user.username}</dd>{Number.isFinite(created.getTime()) && <><dt>Member since</dt><dd><time dateTime={user.created_at}>{new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(created)}</time></dd></>}</dl>
    <button type="button" className="account-action" onClick={onLogout}><Icon name="logout" />Log out</button>
    {photos && <ProfileSurface user={user} own onClose={closePhotos} onUpdated={state.update} />}
    {editing && <BiographyEditor biography={state.profile.biography} onClose={closeEdit} onSave={async text => state.update(await identity.guard(saveBiography(identity.token,text)))} />}
    {crop && <CropDialog image={crop} onClose={closeCrop} onSave={async blob => {state.update(await identity.guard(uploadPhoto(identity.token,blob)));closeCrop()}} />}
  </section>
}

export function SettingsPage({ theme, onToggleTheme }) {
  return <section aria-label="Appearance settings" className="settings-page navigation-surface">
    <p className="settings-label">Appearance</p>
    <button type="button" className="preference-row" aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`} onClick={onToggleTheme}>
      <Icon name={theme === 'dark' ? 'moon' : 'sun'} /><span>Theme<small>{theme === 'dark' ? 'Dark' : 'Light'}</small></span><span className="preference-value">Change</span>
    </button>
    <p className="settings-note">Saved on this device. Motion follows your device’s accessibility preference.</p>
  </section>
}
