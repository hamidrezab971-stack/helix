from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.database.database import Base


class MessageAttachment(Base):
    __tablename__ = "message_attachments"
    __table_args__ = (
        CheckConstraint("kind = 'image' AND size_bytes > 0 AND width > 0 AND height > 0", name="ck_image_attachment"),
        {"sqlite_autoincrement": True},  # Deleted download IDs must not target a replacement image.
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    message_id: Mapped[int] = mapped_column(ForeignKey("messages.id"), nullable=False, unique=True)
    kind: Mapped[str] = mapped_column(String(10), nullable=False, default="image")
    storage_name: Mapped[str] = mapped_column(String(40), nullable=False, unique=True)
    original_name: Mapped[str | None] = mapped_column(String(150))
    mime_type: Mapped[str] = mapped_column(String(20), nullable=False)
    size_bytes: Mapped[int] = mapped_column(nullable=False)
    width: Mapped[int] = mapped_column(nullable=False)
    height: Mapped[int] = mapped_column(nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=func.current_timestamp())
