import logging
import re
import warnings
from io import BytesIO
from uuid import uuid4

from fastapi import HTTPException
from PIL import Image, UnidentifiedImageError

from app.core.config import UPLOAD_DIR

IMAGE_MESSAGE_SENTINEL = "[image]"
MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_IMAGE_PIXELS = 25_000_000
IMAGE_FORMATS = {"JPEG": ("jpg", "image/jpeg"), "PNG": ("png", "image/png"), "WEBP": ("webp", "image/webp")}


def image_path(storage_name: str):
    root = (UPLOAD_DIR / "images").resolve()
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
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError, Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise HTTPException(status_code=422, detail="Use a valid, non-animated JPEG, PNG, or WEBP image with safe dimensions") from None
    storage_name = f"{uuid4().hex}.{extension}"
    path = image_path(storage_name)
    created = False
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("xb") as destination:
            created = True
            destination.write(data)
    except OSError:
        if created:
            remove_image(storage_name)
        raise HTTPException(status_code=503, detail="Unable to store image. Please try again") from None
    name = (file.filename or "").replace("\\", "/").split("/")[-1]
    return dict(storage_name=storage_name, original_name="".join(c for c in name if c.isprintable())[:150] or None,
                mime_type=mime_type, size_bytes=len(data), width=width, height=height)
