from datetime import datetime
from pydantic import BaseModel, ConfigDict, Field, field_validator
from app.schemas.auth import UserResponse


class BiographyUpdate(BaseModel):
    biography: str = Field(max_length=1000)

    @field_validator('biography', mode='before')
    @classmethod
    def normalize(cls, value):
        if isinstance(value, str):
            value = value.replace('\r\n','\n').replace('\r','\n')
            if '\x00' in value or any(0xD800 <= ord(c) <= 0xDFFF for c in value):
                raise ValueError('Use valid Unicode text')
        return value


class PhotoResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    position: int
    width: int
    height: int
    size_bytes: int
    created_at: datetime


class ProfileResponse(UserResponse):
    biography: str
    photos: list[PhotoResponse]
    max_photos: int
