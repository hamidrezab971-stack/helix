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


class MessageResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    conversation_id: int
    sender_id: int
    content: str
    created_at: datetime
    delivered_at: datetime | None = None
    read_at: datetime | None = None


class ConversationResponse(BaseModel):
    id: int
    created_at: datetime
    other_user: UserResponse
