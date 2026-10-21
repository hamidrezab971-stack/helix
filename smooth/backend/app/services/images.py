import logging
import os
import re
import warnings
from io import BytesIO
from uuid import uuid4

from fastapi import HTTPException
from PIL import Image, ImageOps, UnidentifiedImageError

from app.core.config import UPLOAD_DIR

IMAGE_MESSAGE_SENTINEL = "[image]"
MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_IMAGE_PIXELS = 25_000_000
IMAGE_FORMATS = {"JPEG": ("jpg", "image/jpeg"), "PNG": ("png", "image/png"), "WEBP": ("webp", "image/webp")}


def image_path(storage_name: str):
    namespace = UPLOAD_DIR / "images"
    if namespace.is_symlink():
        raise HTTPException(status_code=404, detail="Attachment not found")
    root = namespace.resolve()
    if not re.fullmatch(r"[a-f0-9]{32}\.(jpg|png|webp)", storage_name):
        raise HTTPException(status_code=404, detail="Attachment not found")
    path = root / storage_name
    if path.is_symlink() or path.resolve().parent != root:
        raise HTTPException(status_code=404, detail="Attachment not found")
    return path


def remove_image(storage_name: str) -> None:
    try:
        image_path(storage_name).unlink(missing_ok=True)
    except (OSError, HTTPException):
        # Cleanup failure must not prevent committed message deletion/events.
        logging.getLogger(__name__).warning("Unable to remove stored image")


def store_image(file) -> dict:
    data = file.file.read(MAX_IMAGE_BYTES + 1)
    if len(data) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="Images must be 8 MB or smaller")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(data)) as image:
                if image.format not in IMAGE_FORMATS or getattr(image, "is_animated", False):
                    raise ValueError
                width, height = image.size
                if width * height > MAX_IMAGE_PIXELS or max(width, height) > 16000:
                    raise ValueError
                extension, mime_type = IMAGE_FORMATS[image.format]
                image.verify()
            # verify alone does not fully decode JPEG pixel data.
            with Image.open(BytesIO(data)) as image:
                image.load()
                # Keep already clean originals byte-for-byte. Photos carrying
                # private metadata are oriented then encoded from fresh pixels.
                if image.getexif() or any(key.lower() in ('exif', 'xmp', 'xml:com.adobe.xmp', 'icc_profile', 'comment', 'description', 'photoshop') for key in image.info) or getattr(image, 'text', None):
                    format = image.format
                    oriented = ImageOps.exif_transpose(image)
                    mode = 'RGBA' if format != 'JPEG' and ('A' in oriented.getbands() or 'transparency' in image.info) else 'RGB'
                    pixels = oriented.convert(mode)
                    clean = Image.new(mode, pixels.size)
                    clean.paste(pixels)
                    output = BytesIO()
                    clean.save(output, format=format, **({'quality': 92} if format in ('JPEG', 'WEBP') else {}))
                    data = output.getvalue()
                    width, height = clean.size
                    clean.close(); pixels.close()
                    if oriented is not image:
                        oriented.close()
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError, Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise HTTPException(status_code=422, detail="Use a valid, non-animated JPEG, PNG, or WEBP image with safe dimensions") from None
    if len(data) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="Prepared image must be 8 MB or smaller")
    storage_name = f"{uuid4().hex}.{extension}"
    path = image_path(storage_name)
    created = False
    try:
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), 'wb') as destination:
            created = True
            destination.write(data)
            destination.flush()
            os.fsync(destination.fileno())
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    except OSError:
        if created:
            remove_image(storage_name)
        raise HTTPException(status_code=503, detail="Unable to store image. Please try again") from None
    name = (file.filename or "").replace("\\", "/").split("/")[-1]
    return dict(storage_name=storage_name, original_name="".join(c for c in name if c.isprintable())[:150] or None,
                mime_type=mime_type, size_bytes=len(data), width=width, height=height)
