from typing import Annotated
from fastapi import APIRouter, BackgroundTasks, Depends, File, HTTPException, Response, UploadFile
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.core.auth import get_current_user
from app.core.config import PROFILE_MAX_PHOTOS
from app.database.database import get_db
from app.models.user import User
from app.models.profile import UserProfilePhoto
from app.schemas.profile import BiographyUpdate, ProfileResponse
from app.services import profile_images
from app.services.antibot import atomic, quota, image_work
from app.services.presence import allowed_peers
from app.realtime.manager import manager

router = APIRouter(prefix='/api/profiles',tags=['profiles'])
Current = Annotated[User, Depends(get_current_user)]
DB = Annotated[Session, Depends(get_db)]


def view(db, user_id):
    db.expire_all()
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(404, 'Profile unavailable.')
    photos = list(db.scalars(select(UserProfilePhoto).where(UserProfilePhoto.user_id==user_id).order_by(UserProfilePhoto.position,UserProfilePhoto.id).limit(50)))
    return ProfileResponse(id=user.id, username=user.username, created_at=user.created_at,
        primary_photo_id=user.primary_photo_id, profile_version=user.profile_version, biography=user.biography or '', photos=photos, max_photos=PROFILE_MAX_PHOTOS)


def updated(db, user_id, tasks):
    profile = view(db,user_id)
    if tasks is not None:
        recipients = [user_id, *[peer.id for peer in db.scalars(allowed_peers(db,user_id))]]
        tasks.add_task(manager.broadcast, recipients, {'type':'profile:update','data':{
            'id':profile.id,'primary_photo_id':profile.primary_photo_id,'profile_version':profile.profile_version}})
    return profile


@router.get('/me', response_model=ProfileResponse)
def current(user: Current, db: DB):
    return view(db,user.id)


@router.patch('/me', response_model=ProfileResponse)
def biography(data: BiographyUpdate, user: Current, db: DB, tasks: BackgroundTasks = None):
    quota('profile-edit',str(user.id),120,3600)
    user.biography = data.biography
    db.commit()
    return updated(db,user.id,tasks)


@router.get('/photos/{photo_id}/content')
def content(photo_id: int, user: Current, db: DB):
    photo = db.get(UserProfilePhoto,photo_id)
    if not photo:
        raise HTTPException(404, 'Photo unavailable.')
    return Response(profile_images.read(photo.storage_name), media_type='image/webp', headers={
        'Cache-Control':'private, no-store', 'X-Content-Type-Options':'nosniff',
        'Content-Security-Policy':"default-src 'none'", 'Content-Disposition':'inline; filename="profile.webp"'})


@router.get('/{user_id}', response_model=ProfileResponse)
def public(user_id: int, user: Current, db: DB):
    # Same authenticated directory authorization as /api/users.
    return view(db,user_id)


@router.post('/me/photos',response_model=ProfileResponse,status_code=201)
def upload(user: Current, db: DB, file: UploadFile = File(...), tasks: BackgroundTasks = None):
    quota('photo-upload',str(user.id),30,3600)
    with image_work():
        data = profile_images.normalize(file)
    profile_images.collect()
    # Queue storage intent durably before opening a file. Take the write lock
    # for count/position/insert to enforce the cap across concurrent requests.
    from uuid import uuid4
    import time
    name = uuid4().hex + '.webp'
    with atomic() as c:
        c.execute(text('INSERT INTO profile_file_gc(storage_name,available_after) VALUES (:n,:later)'), {'n':name,'later':int(time.time())+120})
    try:
        with atomic() as c:
            count = c.scalar(text('SELECT count(*) FROM user_profile_photos WHERE user_id=:id'), {'id':user.id})
            if count >= PROFILE_MAX_PHOTOS:
                raise HTTPException(409, 'Your photo gallery is full.')
            position = c.scalar(text('SELECT coalesce(max(position),-1)+1 FROM user_profile_photos WHERE user_id=:id'), {'id':user.id})
            # GC cannot race while this SQLite write lock is held.
            with profile_images.directory() as fd:
                import os
                handle = os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=fd)
                with os.fdopen(handle,'wb') as output:
                    output.write(data); output.flush(); os.fsync(output.fileno())
                # Persist the directory entry before SQLite can commit its row.
                os.fsync(fd)
            c.execute(text('''INSERT INTO user_profile_photos(user_id,storage_name,position,width,height,size_bytes)
                VALUES (:id,:n,:p,512,512,:s)'''), {'id':user.id,'n':name,'p':position,'s':len(data)})
            c.execute(text('DELETE FROM profile_file_gc WHERE storage_name=:n'), {'n':name})
    except BaseException as error:
        with atomic() as c:
            c.execute(text('UPDATE profile_file_gc SET available_after=0 WHERE storage_name=:n'), {'n':name})
        profile_images.collect()
        if isinstance(error,OSError):
            raise HTTPException(503,'Unable to store photo. Please try again.') from None
        raise
    return updated(db,user.id,tasks)


@router.patch('/me/photos/{photo_id}/primary',response_model=ProfileResponse)
def primary(photo_id: int, user: Current, db: DB, tasks: BackgroundTasks = None):
    quota('profile-edit',str(user.id),120,3600)
    with atomic() as c:
        if not c.scalar(text('SELECT id FROM user_profile_photos WHERE id=:p AND user_id=:u'), {'p':photo_id,'u':user.id}):
            raise HTTPException(404,'Photo unavailable.')
        c.execute(text('UPDATE users SET primary_photo_id=:p WHERE id=:u'), {'p':photo_id,'u':user.id})
    return updated(db,user.id,tasks)


@router.delete('/me/photos/{photo_id}',response_model=ProfileResponse)
def delete(photo_id: int, user: Current, db: DB, tasks: BackgroundTasks = None):
    quota('profile-edit',str(user.id),120,3600)
    with atomic() as c:
        row = c.execute(text('SELECT user_id FROM user_profile_photos WHERE id=:p'), {'p':photo_id}).first()
        if row and row.user_id != user.id:
            raise HTTPException(404,'Photo unavailable.')
        # Idempotent for already-deleted IDs. Trigger elects primary and queues GC.
        c.execute(text('DELETE FROM user_profile_photos WHERE id=:p AND user_id=:u'), {'p':photo_id,'u':user.id})
    profile_images.collect()
    return updated(db,user.id,tasks)
