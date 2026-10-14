from pydantic import BaseModel, Field, field_validator

from app.core.reactions import ALLOWED_REACTIONS


class ReactionRequest(BaseModel):
    emoji: str = Field(min_length=1, max_length=16)

    @field_validator("emoji")
    @classmethod
    def supported_emoji(cls, value: str) -> str:
        if value not in ALLOWED_REACTIONS:
            raise ValueError("Choose a supported reaction")
        return value


class ReactionSummary(BaseModel):
    emoji: str
    count: int = Field(ge=1)
    reacted_by_me: bool
