from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from app.core.reactions import ALLOWED_REACTIONS
from app.models.message_reaction import MessageReaction
from app.schemas.reactions import ReactionSummary


def reaction_summaries(db: Session, message_ids: list[int], user_id: int) -> dict[int, list[ReactionSummary]]:
    if not message_ids:
        return {}
    rows = db.execute(select(
        MessageReaction.message_id, MessageReaction.emoji,
        func.count(MessageReaction.id),
        func.max(case((MessageReaction.user_id == user_id, 1), else_=0)),
    ).where(MessageReaction.message_id.in_(message_ids)).group_by(MessageReaction.message_id, MessageReaction.emoji))
    grouped = {}
    for message_id, emoji, count, reacted in rows:
        grouped.setdefault(message_id, {})[emoji] = ReactionSummary(emoji=emoji, count=count, reacted_by_me=bool(reacted))
    return {message_id: [values[emoji] for emoji in ALLOWED_REACTIONS if emoji in values] for message_id, values in grouped.items()}
