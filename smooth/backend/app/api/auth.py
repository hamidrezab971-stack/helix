from sqlite3 import SQLITE_CONSTRAINT_UNIQUE
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from typing import Literal
from app.services.antibot import issue, consume, auth_limits, outcome, password_work
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


@router.get('/challenge')
def challenge(request: Request, response: Response, purpose: Literal['login', 'register']):
    response.headers['Cache-Control'] = 'no-store'
    return issue(request, purpose)


@router.post(
    "/register", response_model=UserResponse, status_code=status.HTTP_201_CREATED
)
def register_user(
    data: RegistrationRequest, request: Request, db: Annotated[Session, Depends(get_db)]
) -> User:
    key = auth_limits(request, 'register', data.username)
    try:
        consume(data.altcha, 'register')
    except HTTPException:
        outcome(key, False)
        raise
    if db.scalar(select(User.id).where(User.username == data.username)) is not None:
        outcome(key, False)
        raise HTTPException(status_code=409, detail="Unable to create account with these details")

    with password_work():
        password_hash = hash_password(data.password.get_secret_value())
    user = User(username=data.username, password_hash=password_hash)
    db.add(user)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        if getattr(exc.orig, "sqlite_errorcode", None) == SQLITE_CONSTRAINT_UNIQUE:
            raise HTTPException(
                status_code=409, detail="Unable to create account with these details"
            ) from None
        raise

    db.refresh(user)
    outcome(key, True)
    return user


@router.post("/login", response_model=TokenResponse)
def login(
    data: LoginRequest, request: Request, db: Annotated[Session, Depends(get_db)]
) -> TokenResponse:
    key = auth_limits(request, 'login', data.username)
    try:
        consume(data.altcha, 'login')
    except HTTPException:
        outcome(key, False)
        raise
    user = db.scalar(select(User).where(User.username == data.username))
    password_hash = user.password_hash if user is not None else DUMMY_PASSWORD_HASH
    with password_work():
        password_valid = verify_password(data.password.get_secret_value(), password_hash)
    if user is None or not password_valid:
        outcome(key, False)
        raise HTTPException(
            status_code=401,
            detail="Invalid username or password",
            headers={"WWW-Authenticate": "Bearer"},
        )
    outcome(key, True)
    return TokenResponse(access_token=create_access_token(user.id, user.username))


@router.get("/me", response_model=UserResponse)
def me(user: Annotated[User, Depends(get_current_user)]) -> User:
    return user
