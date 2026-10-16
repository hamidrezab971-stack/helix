"""Server-clock last seen, exposed only to existing conversation members."""
from datetime import UTC, datetime
from sqlalchemy import select, update
from sqlalchemy.orm import aliased
from app.database.database import SessionLocal
from app.models.conversation_member import ConversationMember
from app.models.user import User


def iso_utc(value):
    return value.replace(tzinfo=UTC).isoformat() if value else None


def persist_seen(user_id):
    stamp = datetime.now(UTC).replace(tzinfo=None)
    with SessionLocal() as db:
        db.execute(update(User).where(User.id == user_id).values(last_seen_at=stamp))
        db.commit()
    return iso_utc(stamp)


def allowed_peers(db, user_id):
    other = aliased(ConversationMember)
    return (select(User).join(other, other.user_id == User.id)
            .join(ConversationMember, ConversationMember.conversation_id == other.conversation_id)
            .where(ConversationMember.user_id == user_id, User.id != user_id).distinct())


def presence_recipients(user_id):
    with SessionLocal() as db:
        return [user_id, *[peer.id for peer in db.scalars(allowed_peers(db, user_id))]]
