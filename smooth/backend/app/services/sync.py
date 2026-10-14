"""Transactional invalidation journal and consistent, bounded SQLite snapshots."""
from datetime import datetime
from time import time

import jwt
from fastapi import HTTPException
from sqlalchemy import String, and_, delete, literal_column, select
from sqlalchemy.dialects.sqlite import insert

from app.core.config import SECRET_KEY
from app.models.conversation_event import ConversationEvent, ConversationSyncState
from app.models.message import Message
from app.models.message_attachment import MessageAttachment
from app.models.message_edit import MessageEdit
from app.models.message_receipt import MessageReceipt
from app.services.messages import effective_message, reply_previews
from app.services.reactions import reaction_summaries

CURSOR_LIFETIME = 7 * 24 * 60 * 60
# SQLite's CURRENT_TIMESTAMP omits fractions; SQLAlchemy writes six digits.
# Compare a canonical text key without rewriting existing message timestamps.
TIMESTAMP_SQL = "CASE WHEN instr(created_at, '.') = 0 THEN created_at || '.000000' ELSE substr(created_at || '000000', 1, 26) END"
timeline_timestamp = literal_column(TIMESTAMP_SQL.replace('created_at', 'messages.created_at'), type_=String)


def snapshot(db):
    # sqlite3's legacy transaction mode does not BEGIN for SELECT. All HTTP
    # snapshot/replay reads must see the watermark and message state atomically.
    connection = db.connection()
    if not connection.connection.driver_connection.in_transaction:
        connection.exec_driver_sql('BEGIN')


def record_event(db, conversation_id, kind, message_id=None):
    event = ConversationEvent(conversation_id=conversation_id, kind=kind, message_id=message_id)
    db.add(event)
    db.flush()
    statement = insert(ConversationSyncState).values(conversation_id=conversation_id, head=event.id, floor=0)
    db.execute(statement.on_conflict_do_update(index_elements=['conversation_id'], set_={'head': event.id}))
    # Caller commits the event with its mutation. Publication happens afterward.
    return event.id


def prune_events(db, conversation_id, through):
    """Operator-controlled retention in the same transaction as its replay floor."""
    state = db.get(ConversationSyncState, conversation_id)
    if state is None or type(through) is not int or not state.floor <= through <= state.head:
        raise ValueError('Invalid retention boundary')
    state.floor = through
    db.execute(delete(ConversationEvent).where(ConversationEvent.conversation_id == conversation_id, ConversationEvent.id <= through))
    db.flush()


def state_bounds(db, conversation_id):
    state = db.get(ConversationSyncState, conversation_id)
    return (state.head, state.floor) if state else (0, 0)


def cursor(kind, conversation_id, **values):
    return jwt.encode({'v': 17, 'kind': kind, 'c': conversation_id, 'exp': int(time()) + CURSOR_LIFETIME, **values}, SECRET_KEY, algorithm='HS256')


def decode_cursor(value, kind, conversation_id):
    try:
        if not isinstance(value, str) or len(value) > 1024:
            raise ValueError
        data = jwt.decode(value, SECRET_KEY, algorithms=['HS256'], options={'require': ['exp']})
        if data.get('v') != 17 or data.get('kind') != kind or data.get('c') != conversation_id:
            raise ValueError
        return data
    except jwt.ExpiredSignatureError:
        raise HTTPException(410, detail='Cursor expired; reload the conversation') from None
    except (jwt.PyJWTError, ValueError, TypeError):
        raise HTTPException(422, detail='Invalid conversation cursor') from None


def message_cursor(message):
    return cursor('history', message.conversation_id, t=message.created_at.isoformat(), i=message.id)


def boundary(value, conversation_id, kind='history'):
    data = decode_cursor(value, kind, conversation_id)
    try:
        if type(data['i']) is not int or not 0 < data['i'] < 2**63:
            raise ValueError
        timestamp = datetime.fromisoformat(data['t'])
        if timestamp.tzinfo is not None:
            raise ValueError
        return timestamp, data['i'], data
    except (ValueError, KeyError, TypeError):
        raise HTTPException(422, detail='Invalid conversation cursor') from None


def older_than(timestamp, message_id):
    value = timestamp.isoformat(sep=' ', timespec='microseconds')
    return (timeline_timestamp < value) | and_(timeline_timestamp == value, Message.id < message_id)


def newer_than(timestamp, message_id):
    value = timestamp.isoformat(sep=' ', timespec='microseconds')
    return (timeline_timestamp > value) | and_(timeline_timestamp == value, Message.id > message_id)


def message_query():
    return (select(Message, MessageReceipt, MessageEdit, MessageAttachment)
            .outerjoin(MessageReceipt, MessageReceipt.message_id == Message.id)
            .outerjoin(MessageEdit, MessageEdit.message_id == Message.id)
            .outerjoin(MessageAttachment, MessageAttachment.message_id == Message.id))


def serialize_rows(db, rows, user_id):
    messages = [row[0] for row in rows]
    replies = reply_previews(db, messages)
    reactions = reaction_summaries(db, [message.id for message in messages], user_id)
    return [effective_message(message, receipt, edit, attachment, replies.get(message.id), reactions.get(message.id)).model_dump(mode='json')
            for message, receipt, edit, attachment in rows]


def snapshot_metadata(db, conversation_id, user_id):
    head, _ = state_bounds(db, conversation_id)
    latest = db.scalar(select(Message).where(Message.conversation_id == conversation_id).order_by(timeline_timestamp.desc(), Message.id.desc()).limit(1))
    return {'read_through_id': latest.id if latest else None, 'event_id': head, 'sync_cursor': cursor('sync', conversation_id, s=head),
            'read_cursor': cursor('read', conversation_id, u=user_id, t=latest.created_at.isoformat(), i=latest.id) if latest else None}


def page_response(db, conversation_id, user_id, rows):
    messages = [row[0] for row in rows]
    older = bool(messages and db.scalar(select(Message.id).where(Message.conversation_id == conversation_id, older_than(messages[0].created_at, messages[0].id)).limit(1)))
    newer = bool(messages and db.scalar(select(Message.id).where(Message.conversation_id == conversation_id, newer_than(messages[-1].created_at, messages[-1].id)).limit(1)))
    return {'items': serialize_rows(db, rows, user_id), 'has_more': older,
            'has_older': older, 'has_newer': newer,
            'next_cursor': message_cursor(messages[0]) if older else None,
            'cursors': {message.id: message_cursor(message) for message in messages},
            **snapshot_metadata(db, conversation_id, user_id)}
