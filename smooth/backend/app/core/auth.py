from typing import Annotated

from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jwt import InvalidTokenError
from sqlalchemy.orm import Session

from app.core.security import decode_access_token
from app.database.database import get_db
from app.models.user import User

bearer = HTTPBearer(auto_error=False)


def authenticate_access_token(token: str, db: Session) -> tuple[User, float]:
    unauthorized = HTTPException(
        status_code=401,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = decode_access_token(token)
        user_id = int(payload["sub"])
        expires_at = float(payload["exp"])
        # SQLite IDs must fit a signed 64-bit integer; require a canonical ID.
        if str(user_id) != payload["sub"] or not 0 < user_id < 2**63:
            raise ValueError
    except (InvalidTokenError, KeyError, TypeError, ValueError):
        raise unauthorized from None

    user = db.get(User, user_id)
    if user is None or user.username != payload["username"]:
        raise unauthorized
    return user, expires_at


def get_current_user(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)],
    db: Annotated[Session, Depends(get_db)],
) -> User:
    if credentials is None:
        raise HTTPException(
            status_code=401,
            detail="Could not validate credentials",
            headers={"WWW-Authenticate": "Bearer"},
        )
    user, _ = authenticate_access_token(credentials.credentials, db)
    return user
