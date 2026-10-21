"""Only decoded, re-encoded profile images enter this storage namespace."""
from contextlib import contextmanager
from io import BytesIO
import logging
import os
import re
import stat
import time
import warnings

from fastapi import HTTPException
from PIL import Image, ImageOps, UnidentifiedImageError
from sqlalchemy import text

from app.core.config import UPLOAD_DIR
from app.database.database import engine

MAX_BYTES = 2 * 1024 * 1024
MAX_PIXELS = 16_000_000
log = logging.getLogger(__name__)


@contextmanager
def directory():
    # openat + NOFOLLOW for both namespace and files. Never follow a symlink
    # introduced between validation and opening/deleting a path.
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    with_directory = os.open(UPLOAD_DIR, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        try:
            os.mkdir('profiles', mode=0o700, dir_fd=with_directory)
        except FileExistsError:
            pass
        # Retry a previously failed parent sync even when mkdir already exists.
        os.fsync(with_directory)
        fd = os.open('profiles', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=with_directory)
        try:
            yield fd
        finally:
            os.close(fd)
    finally:
        os.close(with_directory)


def valid_name(name):
    if not re.fullmatch(r'[0-9a-f]{32}\.webp', name):
        raise ValueError('Invalid profile storage identifier')


def normalize(file):
    data = file.file.read(MAX_BYTES+1)
    if len(data) > MAX_BYTES:
        raise HTTPException(413, 'Choose a profile image of 2 MB or smaller.')
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            with Image.open(BytesIO(data)) as source:
                if source.format not in ('JPEG','PNG','WEBP') or getattr(source,'is_animated',False):
                    raise ValueError
                if source.width * source.height > MAX_PIXELS or max(source.size)>8192:
                    raise ValueError
                source.verify()
            with Image.open(BytesIO(data)) as source:
                source.load()
                oriented = ImageOps.exif_transpose(source)
                square = ImageOps.fit(oriented, (512,512), method=Image.Resampling.LANCZOS).convert('RGBA')
                # Fresh pixel image excludes EXIF, XMP, ICC, comments and GPS.
                clean = Image.new('RGBA', square.size)
                clean.paste(square)
                out = BytesIO()
                clean.save(out, 'WEBP', quality=88, method=4)
                return out.getvalue()
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError, Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise HTTPException(422, 'Choose a valid, non-animated JPEG, PNG or WebP with safe dimensions.') from None


def read(name):
    valid_name(name)
    try:
        with directory() as fd:
            handle = os.open(name,os.O_RDONLY | os.O_NOFOLLOW,dir_fd=fd)
            with os.fdopen(handle,'rb') as source:
                meta = os.fstat(source.fileno())
                if not stat.S_ISREG(meta.st_mode) or meta.st_size > MAX_BYTES:
                    raise OSError
                return source.read(MAX_BYTES+1)
    except OSError:
        raise HTTPException(404, 'Photo unavailable.') from None


def unlink(name):
    valid_name(name)
    with directory() as fd:
        try:
            os.unlink(name,dir_fd=fd)
        except FileNotFoundError:
            pass
        # Also flush on retry after an earlier unlink succeeded but sync failed.
        # GC must not discard its durable intent until removal is persisted.
        os.fsync(fd)


def collect():
    # Serialize GC with uploads: a filename is queued BEFORE it is created.
    # If an upload/commit/process fails, the persisted queue removes its file.
    with engine.connect() as c:
        c.exec_driver_sql('BEGIN IMMEDIATE')
        rows = c.execute(text('SELECT storage_name FROM profile_file_gc WHERE available_after<=:now LIMIT 100'), {'now':int(time.time())}).scalars().all()
        for name in rows:
            if c.scalar(text('SELECT id FROM user_profile_photos WHERE storage_name=:n'), {'n':name}):
                continue
            try:
                unlink(name)
            except (OSError, ValueError):
                log.warning('Profile file cleanup pending')
                continue
            c.execute(text('DELETE FROM profile_file_gc WHERE storage_name=:n'), {'n':name})
        c.commit()
