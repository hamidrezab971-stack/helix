from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.database.database import Base


class MessageEdit(Base):
    __tablename__ = "message_edits"
    __table_args__ = (CheckConstraint("length(content) BETWEEN 1 AND 2000", name="ck_message_edits_content_length"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    message_id: Mapped[int] = mapped_column(ForeignKey("messages.id"), nullable=False, unique=True)
    content: Mapped[str] = mapped_column(String(2000), nullable=False)
    edited_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=func.current_timestamp())
