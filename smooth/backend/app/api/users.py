from typing import Annotated
from datetime import UTC, datetime

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.auth import get_current_user
from app.database.database import get_db
from app.models.user import User
from app.schemas.auth import UserResponse
from app.realtime.manager import manager
from app.services.presence import allowed_peers, iso_utc

router = APIRouter(prefix="/api/users", tags=["users"])


@router.get("", response_model=list[UserResponse])
def list_users(
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
    search: str = "",
) -> list[User]:
    query = select(User).where(User.id != user.id)
    normalized_search = search.strip().lower()
    if normalized_search:
        # Treat SQL LIKE wildcard characters as literal username characters.
        query = query.where(
            func.lower(User.username).contains(normalized_search, autoescape=True)
        )
    query = query.order_by(User.username.asc(), User.id.asc()).limit(50)
    return list(db.scalars(query))


@router.get('/presence')
def presence_snapshot(user: Annotated[User, Depends(get_current_user)], db: Annotated[Session, Depends(get_db)]):
    return {"server_time": datetime.now(UTC).isoformat(), "users": [
        {"user_id": peer.id, "online": peer.id in manager.connections, "last_seen_at": iso_utc(peer.last_seen_at)}
        for peer in db.scalars(allowed_peers(db, user.id))
    ]}
