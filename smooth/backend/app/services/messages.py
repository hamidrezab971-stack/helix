from sqlalchemy import func, select
from sqlalchemy.dialects.sqlite import insert
from sqlalchemy.orm import Session

from app.models.message import Message, MessageIdSequence
from app.models.message_edit import MessageEdit
from app.models.message_receipt import MessageReceipt
from app.models.message_attachment import MessageAttachment
from app.schemas.conversations import AttachmentResponse, MessageResponse
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


def effective_message(message: Message, receipt: MessageReceipt | None, edit: MessageEdit | None, attachment: MessageAttachment | None = None) -> MessageResponse:
    return MessageResponse.model_validate(message).model_copy(update={
        "content": "" if attachment and message.content == IMAGE_MESSAGE_SENTINEL else edit.content if edit else message.content,
        "edited_at": edit.edited_at if edit else None,
        "delivered_at": receipt.delivered_at if receipt else None,
        "read_at": receipt.read_at if receipt else None,
        "attachment": AttachmentResponse.model_validate(attachment) if attachment else None,
    })
