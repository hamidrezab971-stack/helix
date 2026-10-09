from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Path, Response
from sqlalchemy import delete, func, or_, select
from sqlalchemy.dialects.sqlite import insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.conversations import require_membership
from app.core.auth import get_current_user
from app.database.database import get_db
from app.models.conversation_member import ConversationMember
from app.models.message import Message
from app.models.message_edit import MessageEdit
from app.models.message_receipt import MessageReceipt
from app.models.message_attachment import MessageAttachment
from app.models.message_reply import MessageReply
from app.models.user import User
from app.realtime.manager import manager
from app.schemas.conversations import MessageRequest, MessageResponse
from app.services.messages import effective_message, reply_previews
from app.services.images import remove_image

router = APIRouter(prefix="/api/messages", tags=["messages"])


def require_sender(message_id: int, user_id: int, db: Session) -> Message:
    message = db.get(Message, message_id)
    if message is None or message.sender_id != user_id:
        raise HTTPException(status_code=404, detail="Message not found")
    require_membership(message.conversation_id, user_id, db)
    return message


def members(conversation_id: int, db: Session) -> list[int]:
    return list(db.scalars(select(ConversationMember.user_id).where(
        ConversationMember.conversation_id == conversation_id,
    )))


@router.patch("/{message_id}", response_model=MessageResponse)
def edit_message(
    message_id: Annotated[int, Path(gt=0, lt=2**63)],
    data: MessageRequest,
    background_tasks: BackgroundTasks,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> MessageResponse:
    message = require_sender(message_id, user.id, db)
    if db.scalar(select(MessageAttachment.id).where(MessageAttachment.message_id == message_id)) is not None:
        raise HTTPException(status_code=400, detail="Image captions cannot be edited yet")
    member_ids = members(message.conversation_id, db)
    statement = insert(MessageEdit).values(
        message_id=message_id, content=data.content, edited_at=datetime.now(UTC).replace(tzinfo=None),
    )
    try:
        db.execute(statement.on_conflict_do_update(
            index_elements=["message_id"],
            set_={"content": statement.excluded.content, "edited_at": func.max(MessageEdit.edited_at, statement.excluded.edited_at)},
        ))
        edit = db.scalar(select(MessageEdit).where(MessageEdit.message_id == message_id))
        receipt = db.scalar(select(MessageReceipt).where(MessageReceipt.message_id == message_id))
        saved = effective_message(message, receipt, edit, reply_to=reply_previews(db, [message]).get(message.id))
        db.commit()
    except IntegrityError:
        db.rollback()
        # A concurrent deletion can remove the FK target after authorization.
        raise HTTPException(status_code=404, detail="Message not found") from None
    background_tasks.add_task(manager.broadcast, member_ids, {"type": "message:updated", "data": saved.model_dump(mode="json")})
    return saved


@router.delete("/{message_id}", status_code=204)
def delete_message(
    message_id: Annotated[int, Path(gt=0, lt=2**63)],
    background_tasks: BackgroundTasks,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    message = require_sender(message_id, user.id, db)
    conversation_id = message.conversation_id
    attachment = db.scalar(select(MessageAttachment).where(MessageAttachment.message_id == message_id))
    storage_name = attachment.storage_name if attachment else None
    member_ids = members(conversation_id, db)
    db.execute(delete(MessageReply).where(or_(MessageReply.message_id == message_id, MessageReply.reply_to_message_id == message_id)))
    db.execute(delete(MessageReceipt).where(MessageReceipt.message_id == message_id))
    db.execute(delete(MessageEdit).where(MessageEdit.message_id == message_id))
    db.execute(delete(MessageAttachment).where(MessageAttachment.message_id == message_id))
    db.delete(message)
    db.commit()
    if storage_name:
        remove_image(storage_name)
    background_tasks.add_task(manager.broadcast, member_ids, {
        "type": "message:deleted", "data": {"message_id": message_id, "conversation_id": conversation_id},
    })
    return Response(status_code=204)
