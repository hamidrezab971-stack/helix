from sqlalchemy import ForeignKey, Index, String
from sqlalchemy.orm import Mapped, mapped_column

from app.database.database import Base


class ConversationEvent(Base):
    """Durable invalidations, deliberately without text or personalized payloads."""
    __tablename__ = "conversation_events"
    __table_args__ = (Index("ix_conversation_events_replay", "conversation_id", "id"),
                      {"sqlite_autoincrement": True})

    id: Mapped[int] = mapped_column(primary_key=True)
    conversation_id: Mapped[int] = mapped_column(ForeignKey("conversations.id"), nullable=False)
    kind: Mapped[str] = mapped_column(String(20), nullable=False)
    # No message FK: deletions must remain replayable after the target disappears.
    message_id: Mapped[int | None] = mapped_column(nullable=True)


class ConversationSyncState(Base):
    __tablename__ = "conversation_sync_state"

    conversation_id: Mapped[int] = mapped_column(ForeignKey("conversations.id"), primary_key=True)
    head: Mapped[int] = mapped_column(nullable=False, default=0)
    floor: Mapped[int] = mapped_column(nullable=False, default=0)
