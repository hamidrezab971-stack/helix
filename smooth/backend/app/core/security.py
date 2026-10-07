import secrets
from datetime import UTC, datetime, timedelta
from typing import Any

import jwt
from argon2 import PasswordHasher, Type
from argon2.exceptions import InvalidHashError, VerificationError

from app.core.config import ACCESS_TOKEN_EXPIRE_MINUTES, SECRET_KEY

JWT_ALGORITHM = "HS256"
password_hasher = PasswordHasher(type=Type.ID)
# Verify a dummy hash for unknown users so login still performs Argon2 work.
DUMMY_PASSWORD_HASH = password_hasher.hash(secrets.token_urlsafe(32))


def hash_password(password: str) -> str:
    return password_hasher.hash(password)


def verify_password(plain_password: str, password_hash: str) -> bool:
    try:
        return password_hasher.verify(password_hash, plain_password)
    except (VerificationError, InvalidHashError):
        return False


def create_access_token(user_id: int, username: str) -> str:
    now = datetime.now(UTC)
    payload = {
        "sub": str(user_id),
        "username": username,
        "iat": now,
        "exp": now + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES),
    }
    return jwt.encode(payload, SECRET_KEY, algorithm=JWT_ALGORITHM)


def decode_access_token(token: str) -> dict[str, Any]:
    return jwt.decode(
        token,
        SECRET_KEY,
        algorithms=[JWT_ALGORITHM],
        options={"require": ["sub", "username", "iat", "exp"]},
    )
