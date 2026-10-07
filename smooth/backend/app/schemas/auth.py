from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator


class RegistrationRequest(BaseModel):
    username: str = Field(min_length=3, max_length=30, pattern="^[a-z0-9_]+$")
    password: SecretStr = Field(min_length=8, max_length=128)

    @field_validator("username", mode="before")
    @classmethod
    def normalize_username(cls, value: object) -> object:
        if isinstance(value, str):
            return value.strip().lower()
        return value


class UserResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    username: str
    created_at: datetime
