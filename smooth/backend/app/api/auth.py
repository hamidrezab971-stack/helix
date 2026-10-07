from sqlite3 import SQLITE_CONSTRAINT_UNIQUE
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.security import hash_password
from app.database.database import get_db
from app.models.user import User
from app.schemas.auth import RegistrationRequest, UserResponse

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post(
    "/register", response_model=UserResponse, status_code=status.HTTP_201_CREATED
)
def register_user(
    data: RegistrationRequest, db: Annotated[Session, Depends(get_db)]
) -> User:
    if db.scalar(select(User.id).where(User.username == data.username)) is not None:
        raise HTTPException(status_code=409, detail="Username already exists")

    user = User(
        username=data.username,
        password_hash=hash_password(data.password.get_secret_value()),
    )
    db.add(user)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        if getattr(exc.orig, "sqlite_errorcode", None) == SQLITE_CONSTRAINT_UNIQUE:
            raise HTTPException(
                status_code=409, detail="Username already exists"
            ) from None
        raise

    db.refresh(user)
    return user
