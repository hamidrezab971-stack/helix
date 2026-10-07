from sqlite3 import SQLITE_CONSTRAINT_UNIQUE
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.auth import get_current_user
from app.core.security import (
    DUMMY_PASSWORD_HASH,
    create_access_token,
    hash_password,
    verify_password,
)
from app.database.database import get_db
from app.models.user import User
from app.schemas.auth import (
    LoginRequest,
    RegistrationRequest,
    TokenResponse,
    UserResponse,
)

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


@router.post("/login", response_model=TokenResponse)
def login(
    data: LoginRequest, db: Annotated[Session, Depends(get_db)]
) -> TokenResponse:
    user = db.scalar(select(User).where(User.username == data.username))
    password_hash = user.password_hash if user is not None else DUMMY_PASSWORD_HASH
    password_valid = verify_password(data.password.get_secret_value(), password_hash)
    if user is None or not password_valid:
        raise HTTPException(
            status_code=401,
            detail="Invalid username or password",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return TokenResponse(access_token=create_access_token(user.id, user.username))


@router.get("/me", response_model=UserResponse)
def me(user: Annotated[User, Depends(get_current_user)]) -> User:
    return user
