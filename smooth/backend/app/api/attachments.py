from typing import Annotated

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Path, Request
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile
from starlette.formparsers import MultiPartException
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.api.conversations import require_membership
from app.core.auth import get_current_user
from app.database.database import get_db
from app.models.conversation_member import ConversationMember
from app.models.message import Message
from app.models.message_attachment import MessageAttachment
from app.models.message_receipt import MessageReceipt
from app.models.message_reply import MessageReply
from app.models.user import User
from app.realtime.manager import manager
from app.schemas.conversations import MessageResponse
from app.services.images import IMAGE_MESSAGE_SENTINEL, MAX_IMAGE_BYTES, image_path, remove_image, store_image
from app.services.messages import allocate_message_id, effective_message, reply_previews, validate_reply_target

router = APIRouter(prefix="/api", tags=["images"])


def create_image_message(conversation_id: int, user_id: int, caption: str, file: UploadFile, db: Session, reply_to_message_id: int | None = None):
    require_membership(conversation_id, user_id, db)
    member_ids = list(db.scalars(select(ConversationMember.user_id).where(ConversationMember.conversation_id == conversation_id)))
    recipients = [member_id for member_id in member_ids if member_id != user_id]
    if len(recipients) != 1:
        raise HTTPException(status_code=404, detail="Conversation not found")
    validate_reply_target(db, conversation_id, reply_to_message_id)
    stored = store_image(file)
    try:
        message = Message(id=allocate_message_id(db), conversation_id=conversation_id, sender_id=user_id, content=caption or IMAGE_MESSAGE_SENTINEL)
        db.add(message)
        db.flush()
        attachment = MessageAttachment(message_id=message.id, **stored)
        receipt = MessageReceipt(message_id=message.id, recipient_id=recipients[0])
        db.add_all([attachment, receipt])
        if reply_to_message_id is not None:
            db.add(MessageReply(message_id=message.id, reply_to_message_id=reply_to_message_id))
        db.flush()
        saved = effective_message(message, receipt, None, attachment, reply_previews(db, [message]).get(message.id))
        db.commit()
    except BaseException as error:
        db.rollback()
        remove_image(stored["storage_name"])
        if isinstance(error, IntegrityError) and reply_to_message_id is not None:
            raise HTTPException(status_code=404, detail="Reply target not found") from None
        raise
    return saved, member_ids


@router.post("/conversations/{conversation_id}/messages/image", response_model=MessageResponse, status_code=201)
async def upload_image(
    conversation_id: Annotated[int, Path(gt=0, lt=2**63)],
    request: Request,
    background_tasks: BackgroundTasks,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> MessageResponse:
    # Authenticate and authorize before parsing/spooling the multipart body.
    user_id = user.id
    await run_in_threadpool(require_membership, conversation_id, user_id, db)
    request_limit = MAX_IMAGE_BYTES + 64 * 1024  # Bounded multipart/caption overhead.
    length = request.headers.get("content-length")
    if length and length.isdigit() and int(length) > request_limit:
        raise HTTPException(status_code=413, detail="Images must be 8 MB or smaller")
    received = 0
    too_large = False

    async def bounded_receive():
        nonlocal received, too_large
        frame = await request.receive()
        received += len(frame.get("body", b""))
        if received > request_limit:
            too_large = True
            # The multipart parser closes partial temp files for this exception.
            raise MultiPartException("Upload too large")
        return frame

    bounded = Request(request.scope, receive=bounded_receive)
    try:
        async with bounded.form(max_files=1, max_fields=2, max_part_size=8192) as form:
            file = form.get("file")
            caption = form.get("caption", "")
            if not isinstance(file, UploadFile) or len(form.getlist("file")) != 1 or not isinstance(caption, str):
                raise HTTPException(status_code=422, detail="Choose one image and an optional caption")
            caption = caption.strip()
            target = form.get("reply_to_message_id")
            if target is not None:
                if not isinstance(target, str) or not target.isascii() or not target.isdigit() or len(target) > 19:
                    raise HTTPException(status_code=422, detail="Use a valid reply message ID")
                target = int(target)
            if len(caption) > 2000:
                raise HTTPException(status_code=422, detail="Use a caption up to 2000 characters")
            saved, member_ids = await run_in_threadpool(create_image_message, conversation_id, user_id, caption, file, db, target)
    except StarletteHTTPException:
        if too_large:
            raise HTTPException(status_code=413, detail="Images must be 8 MB or smaller") from None
        raise
    background_tasks.add_task(manager.broadcast, member_ids, {"type": "message:new", "data": saved.model_dump(mode="json")})
    return saved


@router.get("/attachments/{attachment_id}/content")
def download_image(
    attachment_id: Annotated[int, Path(gt=0, lt=2**63)],
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> FileResponse:
    attachment = db.get(MessageAttachment, attachment_id)
    message = db.get(Message, attachment.message_id) if attachment else None
    if message is None:
        raise HTTPException(status_code=404, detail="Attachment not found")
    require_membership(message.conversation_id, user.id, db)
    path = image_path(attachment.storage_name)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Attachment not found")
    return FileResponse(path, media_type=attachment.mime_type, headers={
        "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
    })
