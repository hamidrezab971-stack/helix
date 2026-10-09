from datetime import datetime
from typing import Annotated

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field

from app.schemas.auth import UserResponse


def trim_content(value: object) -> object:
    return value.strip() if isinstance(value, str) else value


class MessageRequest(BaseModel):
    content: Annotated[str, BeforeValidator(trim_content)] = Field(
        min_length=1, max_length=2000
    )
    reply_to_message_id: Annotated[int, Field(strict=True, gt=0, lt=2**63)] | None = None


class AttachmentResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    kind: str
    mime_type: str
    size_bytes: int
    width: int
    height: int


class ReplyPreview(BaseModel):
    id: int
    sender_id: int
    content: str
    attachment_kind: str | None = None


class MessageResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    conversation_id: int
    sender_id: int
    content: str
    created_at: datetime
    delivered_at: datetime | None = None
    read_at: datetime | None = None
    edited_at: datetime | None = None
    attachment: AttachmentResponse | None = None
    reply_to: ReplyPreview | None = None


class ConversationResponse(BaseModel):
    id: int
    created_at: datetime
    other_user: UserResponse


class LastMessageResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    sender_id: int
    content: str
    created_at: datetime
    attachment: AttachmentResponse | None = None


class RecentConversationResponse(BaseModel):
    id: int
    other_user: UserResponse
    last_message: LastMessageResponse | None
    updated_at: datetime
    unread_count: int = Field(ge=0)
