from datetime import UTC, datetime

from sqlalchemy import func, select, update
from sqlalchemy.dialects.sqlite import insert

from app.database.database import SessionLocal
from app.models.conversation_member import ConversationMember
from app.models.message import Message
from app.models.message_receipt import MessageReceipt


def initialize_receipts() -> None:
    # create_all creates the new table; this adds receipts for pre-Phase-10
    # messages without changing their table or inferring delivery/read state.
    with SessionLocal() as db:
        source = select(Message.id, ConversationMember.user_id).join(
            ConversationMember,
            (ConversationMember.conversation_id == Message.conversation_id)
            & (ConversationMember.user_id != Message.sender_id),
        ).where(~select(MessageReceipt.id).where(MessageReceipt.message_id == Message.id).exists())
        db.execute(insert(MessageReceipt).from_select(
            ["message_id", "recipient_id"], source,
        ).on_conflict_do_nothing(index_elements=["message_id"]))
        db.commit()


def acknowledge_message(message_id: int, user_id: int, read: bool) -> tuple[int, dict] | None:
    with SessionLocal() as db:
        message = db.scalar(select(Message).join(
            MessageReceipt, MessageReceipt.message_id == Message.id,
        ).join(ConversationMember, (
            (ConversationMember.conversation_id == Message.conversation_id)
            & (ConversationMember.user_id == user_id)
        )).where(Message.id == message_id, MessageReceipt.recipient_id == user_id))
        if message is None:
            return None
        now = datetime.now(UTC).replace(tzinfo=None)
        values = {"delivered_at": func.coalesce(MessageReceipt.delivered_at, now)}
        if read:
            values["read_at"] = func.coalesce(
                MessageReceipt.read_at, func.max(func.coalesce(MessageReceipt.delivered_at, now), now),
            )
        # The database, rather than a read-then-write assignment, decides which
        # tab wins each transition. Existing timestamps never get overwritten.
        changed = db.execute(update(MessageReceipt).where(
            MessageReceipt.message_id == message_id,
            MessageReceipt.recipient_id == user_id,
            (MessageReceipt.read_at if read else MessageReceipt.delivered_at).is_(None),
        ).values(**values).returning(MessageReceipt.delivered_at, MessageReceipt.read_at)).first()
        sender_id = message.sender_id
        db.commit()
        if changed is None:
            return None
        return sender_id, {
            "message_id": message_id,
            "delivered_at": changed.delivered_at.isoformat() if changed.delivered_at else None,
            "read_at": changed.read_at.isoformat() if changed.read_at else None,
        }
