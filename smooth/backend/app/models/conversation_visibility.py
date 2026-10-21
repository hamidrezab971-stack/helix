from sqlalchemy import Boolean, CheckConstraint, ForeignKey, ForeignKeyConstraint
from sqlalchemy.orm import Mapped, mapped_column
from app.database.database import Base


class ConversationVisibility(Base):
    """Private clear boundary; shared messages/memberships are never removed."""
    __tablename__ = 'conversation_visibility'
    __table_args__ = (
        ForeignKeyConstraint(['conversation_id', 'user_id'],
                             ['conversation_members.conversation_id', 'conversation_members.user_id']),
        CheckConstraint('cleared_through_id >= 0 AND cleared_event_id >= 0'),
    )
    conversation_id: Mapped[int] = mapped_column(ForeignKey('conversations.id'), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey('users.id'), primary_key=True)
    # Message IDs come from the existing transactional monotonic allocator.
    # Deliberately no FK to a message: global message deletion cannot erase this.
    cleared_through_id: Mapped[int] = mapped_column(default=0, nullable=False)
    cleared_event_id: Mapped[int] = mapped_column(default=0, nullable=False)
    hidden: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
