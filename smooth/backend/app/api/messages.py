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
from app.models.message_reaction import MessageReaction
from app.models.user import User
from app.realtime.manager import manager
from app.schemas.conversations import MessageRequest, MessageResponse
from app.services.messages import effective_message, reply_previews
from app.services.images import remove_image
from app.services.reactions import reaction_summaries
from app.services.sync import record_event
from app.services.visibility import require_visible
from app.core.reactions import ALLOWED_REACTIONS
from app.schemas.reactions import ReactionRequest, ReactionSummary

router = APIRouter(prefix="/api/messages", tags=["messages"])


def require_sender(message_id: int, user_id: int, db: Session) -> Message:
    message = db.get(Message, message_id)
    if message is None or message.sender_id != user_id:
        raise HTTPException(status_code=404, detail="Message not found")
    require_membership(message.conversation_id, user_id, db)
    require_visible(db, message, user_id)
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
        saved = effective_message(message, receipt, edit, reply_to=reply_previews(db, [message], user.id).get(message.id), reactions=reaction_summaries(db, [message_id], user.id).get(message_id))
        record_event(db, message.conversation_id, 'updated', message_id)
        db.commit()
    except IntegrityError:
        db.rollback()
        # A concurrent deletion can remove the FK target after authorization.
        raise HTTPException(status_code=404, detail="Message not found") from None
    event_data = saved.model_dump(mode="json")
    event_data.pop("reactions")  # Personalized flags must not be shared with other users.
    background_tasks.add_task(manager.broadcast, member_ids, {"type": "message:updated", "data": event_data})
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
    db.execute(delete(MessageReaction).where(MessageReaction.message_id == message_id))
    db.execute(delete(MessageReply).where(or_(MessageReply.message_id == message_id, MessageReply.reply_to_message_id == message_id)))
    db.execute(delete(MessageReceipt).where(MessageReceipt.message_id == message_id))
    db.execute(delete(MessageEdit).where(MessageEdit.message_id == message_id))
    db.execute(delete(MessageAttachment).where(MessageAttachment.message_id == message_id))
    db.delete(message)
    record_event(db, conversation_id, 'deleted', message_id)
    db.commit()
    if storage_name:
        remove_image(storage_name)
    background_tasks.add_task(manager.broadcast, member_ids, {
        "type": "message:deleted", "data": {"message_id": message_id, "conversation_id": conversation_id},
    })
    return Response(status_code=204)


def require_message_member(message_id: int, user_id: int, db: Session) -> Message:
    message = db.get(Message, message_id)
    if message is None:
        raise HTTPException(status_code=404, detail="Message not found")
    require_membership(message.conversation_id, user_id, db)
    require_visible(db, message, user_id)
    return message


@router.get("/{message_id}/reactions", response_model=list[ReactionSummary])
def get_reactions(
    message_id: Annotated[int, Path(gt=0, lt=2**63)],
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> list[ReactionSummary]:
    require_message_member(message_id, user.id, db)
    return reaction_summaries(db, [message_id], user.id).get(message_id, [])


def notify_reactions(message_id: int, conversation_id: int, member_ids: list[int], background_tasks: BackgroundTasks) -> None:
    background_tasks.add_task(manager.broadcast, member_ids, {
        "type": "message:reactions", "data": {"message_id": message_id, "conversation_id": conversation_id},
    })


@router.post("/{message_id}/reactions", response_model=list[ReactionSummary])
def add_reaction(
    message_id: Annotated[int, Path(gt=0, lt=2**63)],
    data: ReactionRequest,
    response: Response,
    background_tasks: BackgroundTasks,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> list[ReactionSummary]:
    message = require_message_member(message_id, user.id, db)
    conversation_id = message.conversation_id
    member_ids = members(conversation_id, db)
    try:
        result = db.execute(insert(MessageReaction).values(message_id=message_id, user_id=user.id, emoji=data.emoji)
                            .on_conflict_do_nothing(index_elements=["message_id", "user_id", "emoji"]))
        created = result.rowcount > 0
        if created:
            record_event(db, conversation_id, 'reactions', message_id)
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=404, detail="Message not found") from None
    response.status_code = 201 if created else 200
    if created:
        notify_reactions(message_id, conversation_id, member_ids, background_tasks)
    return reaction_summaries(db, [message_id], user.id).get(message_id, [])


@router.delete("/{message_id}/reactions/{emoji}", response_model=list[ReactionSummary])
def remove_reaction(
    message_id: Annotated[int, Path(gt=0, lt=2**63)],
    emoji: str,
    background_tasks: BackgroundTasks,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> list[ReactionSummary]:
    if emoji not in ALLOWED_REACTIONS:
        raise HTTPException(status_code=422, detail="Choose a supported reaction")
    message = require_message_member(message_id, user.id, db)
    conversation_id = message.conversation_id
    member_ids = members(conversation_id, db)
    result = db.execute(delete(MessageReaction).where(MessageReaction.message_id == message_id, MessageReaction.user_id == user.id, MessageReaction.emoji == emoji))
    if result.rowcount:
        record_event(db, conversation_id, 'reactions', message_id)
    db.commit()
    if result.rowcount:
        notify_reactions(message_id, conversation_id, member_ids, background_tasks)
    return reaction_summaries(db, [message_id], user.id).get(message_id, [])
