from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, SecretStr


def normalize_username(value: object) -> object:
    if isinstance(value, str):
        return value.strip().lower()
    return value


NormalizedUsername = Annotated[str, BeforeValidator(normalize_username)]


class RegistrationRequest(BaseModel):
    username: NormalizedUsername = Field(
        min_length=3, max_length=30, pattern="^[a-z0-9_]+$"
    )
    password: SecretStr = Field(min_length=8, max_length=128)
    altcha: str = Field(min_length=1, max_length=8192)


class LoginRequest(BaseModel):
    username: NormalizedUsername = Field(min_length=1, max_length=50)
    password: SecretStr = Field(min_length=1, max_length=128)
    altcha: str = Field(min_length=1, max_length=8192)


class TokenResponse(BaseModel):
    access_token: str
    token_type: Literal["bearer"] = "bearer"


class UserResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    username: str
    created_at: datetime
    primary_photo_id: int | None = None
    profile_version: int = 0
