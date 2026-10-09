from sqlalchemy import CheckConstraint, ForeignKey
from sqlalchemy.orm import Mapped, mapped_column

from app.database.database import Base


class MessageReply(Base):
    __tablename__ = "message_replies"
    __table_args__ = (CheckConstraint("message_id != reply_to_message_id", name="ck_reply_not_self"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    message_id: Mapped[int] = mapped_column(ForeignKey("messages.id"), nullable=False, unique=True)
    reply_to_message_id: Mapped[int] = mapped_column(ForeignKey("messages.id"), nullable=False, index=True)
