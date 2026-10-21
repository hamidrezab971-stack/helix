"""One visibility predicate used by every message read surface."""
from fastapi import HTTPException
from sqlalchemy import func, select
from app.models.conversation_visibility import ConversationVisibility
from app.models.message import Message


def boundary_id(db, conversation_id, user_id):
    return db.scalar(select(ConversationVisibility.cleared_through_id).where(
        ConversationVisibility.conversation_id == conversation_id,
        ConversationVisibility.user_id == user_id)) or 0


def visible_message(user_id, model=Message):
    cutoff = select(ConversationVisibility.cleared_through_id).where(
        ConversationVisibility.conversation_id == model.conversation_id,
        ConversationVisibility.user_id == user_id).correlate(model).scalar_subquery()
    return model.id > func.coalesce(cutoff, 0)


def require_visible(db, message, user_id):
    if message.id <= boundary_id(db, message.conversation_id, user_id):
        raise HTTPException(404, detail='Message not found')


def private_message_event(user_id, event):
    """Filter each recipient at delivery, including delayed pre-clear broadcasts."""
    if event.get('type') not in ('message:new', 'message:updated', 'message:deleted', 'message:reactions', 'message:status'):
        return event
    from app.database.database import SessionLocal
    data = event.get('data', {})
    message_id = data.get('message_id', data.get('id'))
    with SessionLocal() as db:
        conversation_id = data.get('conversation_id')
        if conversation_id is None:
            conversation_id = db.scalar(select(Message.conversation_id).where(Message.id == message_id))
        if conversation_id is None:
            return None
        cutoff = boundary_id(db, conversation_id, user_id)
        if message_id is not None and message_id <= cutoff:
            return None
        if data.get('reply_to') and data['reply_to']['id'] <= cutoff:
            return {**event, 'data': {**data, 'reply_to': None}}
        return event
