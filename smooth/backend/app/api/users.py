from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.auth import get_current_user
from app.database.database import get_db
from app.models.user import User
from app.schemas.auth import UserResponse

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
