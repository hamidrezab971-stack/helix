from datetime import UTC, datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.database.database import Base


class Message(Base):
    __tablename__ = "messages"
    __table_args__ = (
        CheckConstraint(
            "length(content) BETWEEN 1 AND 2000", name="ck_messages_content_length"
        ),
        Index("ix_messages_client_id", "sender_id", "client_message_id", unique=True),
        Index("ix_messages_history", "conversation_id", "created_at", "id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    conversation_id: Mapped[int] = mapped_column(
        ForeignKey("conversations.id"), nullable=False
    )
    sender_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    client_message_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    content: Mapped[str] = mapped_column(String(2000), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, default=lambda: datetime.now(UTC).replace(tzinfo=None), server_default=func.current_timestamp()
    )


class MessageIdSequence(Base):
    # SQLite's existing non-AUTOINCREMENT primary key can reuse a deleted ID.
    # Stable identities are required for socket acknowledgements and mutations.
    __tablename__ = "message_id_sequence"

    id: Mapped[int] = mapped_column(primary_key=True)
    last_value: Mapped[int] = mapped_column(nullable=False)


class MessageSendIntent(Base):
    # Retained after deletion: retrying a committed send must never resurrect it.
    # Only the hash and identity are retained, never text or attachment bytes.
    __tablename__ = "message_send_intents"
    sender_id: Mapped[int] = mapped_column(ForeignKey("users.id"), primary_key=True)
    client_message_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    message_id: Mapped[int] = mapped_column(nullable=False)
    fingerprint: Mapped[str] = mapped_column(String(64), nullable=False)
