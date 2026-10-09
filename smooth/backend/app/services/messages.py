from sqlalchemy import func, select
from sqlalchemy.dialects.sqlite import insert
from sqlalchemy.orm import Session
from sqlalchemy.orm import aliased
from fastapi import HTTPException

from app.models.message import Message, MessageIdSequence
from app.models.message_edit import MessageEdit
from app.models.message_receipt import MessageReceipt
from app.models.message_attachment import MessageAttachment
from app.models.message_reply import MessageReply
from app.schemas.conversations import AttachmentResponse, MessageResponse, ReplyPreview
from app.services.images import IMAGE_MESSAGE_SENTINEL


def allocate_message_id(db: Session) -> int:
    latest = select(func.coalesce(func.max(Message.id), 0)).scalar_subquery()
    # One persistent counter, updated in the message's own transaction. The
    # existing database's maximum initializes it lazily; deletion never resets it.
    statement = insert(MessageIdSequence).values(id=1, last_value=latest + 1)
    return db.execute(statement.on_conflict_do_update(
        index_elements=["id"],
        set_={"last_value": func.max(MessageIdSequence.last_value, latest) + 1},
    ).returning(MessageIdSequence.last_value)).scalar_one()


def effective_message(message: Message, receipt: MessageReceipt | None, edit: MessageEdit | None, attachment: MessageAttachment | None = None, reply_to: ReplyPreview | None = None) -> MessageResponse:
    return MessageResponse.model_validate(message).model_copy(update={
        "content": "" if attachment and message.content == IMAGE_MESSAGE_SENTINEL else edit.content if edit else message.content,
        "edited_at": edit.edited_at if edit else None,
        "delivered_at": receipt.delivered_at if receipt else None,
        "read_at": receipt.read_at if receipt else None,
        "attachment": AttachmentResponse.model_validate(attachment) if attachment else None,
        "reply_to": reply_to,
    })


def validate_reply_target(db: Session, conversation_id: int, target_id: int | None) -> None:
    if target_id is None:
        return
    if type(target_id) is not int or not 0 < target_id < 2**63:
        raise HTTPException(status_code=422, detail="Use a valid reply message ID")
    target = db.get(Message, target_id)
    if target is None or target.conversation_id != conversation_id:
        raise HTTPException(status_code=404, detail="Reply target not found")


def reply_previews(db: Session, messages: list[Message]) -> dict[int, ReplyPreview]:
    if not messages:
        return {}
    target = aliased(Message)
    rows = db.execute(
        select(MessageReply.message_id, target, MessageEdit, MessageAttachment)
        .select_from(MessageReply)
        .join(Message, Message.id == MessageReply.message_id)
        .join(target, target.id == MessageReply.reply_to_message_id)
        .outerjoin(MessageEdit, MessageEdit.message_id == target.id)
        .outerjoin(MessageAttachment, MessageAttachment.message_id == target.id)
        .where(MessageReply.message_id.in_([message.id for message in messages]), target.conversation_id == Message.conversation_id)
    )
    # One batch query, no recursive target replies or per-message profile fetch.
    return {message_id: ReplyPreview(
        id=target_message.id, sender_id=target_message.sender_id,
        content=effective_message(target_message, None, edit, attachment).content[:200],
        attachment_kind=attachment.kind if attachment else None,
    ) for message_id, target_message, edit, attachment in rows}
