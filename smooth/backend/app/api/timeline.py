from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Path, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.api.conversations import require_membership
from app.core.auth import get_current_user
from app.database.database import get_db
from app.models.conversation_member import ConversationMember
from app.models.conversation_event import ConversationEvent
from app.models.message import Message
from app.models.message_receipt import MessageReceipt
from app.models.user import User
from app.realtime.manager import manager
from app.services.sync import (boundary, cursor, decode_cursor, message_cursor, message_query,
                               newer_than, older_than, page_response, record_event, serialize_rows,
                               snapshot, snapshot_metadata, state_bounds, timeline_timestamp)

router = APIRouter(prefix='/api/conversations', tags=['timeline'])
ConversationId = Annotated[int, Path(gt=0, lt=2**63)]
Authenticated = Annotated[User, Depends(get_current_user)]
Database = Annotated[Session, Depends(get_db)]
MessageId = Annotated[int, Field(strict=True, gt=0, lt=2**63)]


class SyncRequest(BaseModel):
    message_ids: list[MessageId] = Field(default_factory=list, max_length=300)


class ReceiptRangeRequest(BaseModel):
    through: str = Field(min_length=1, max_length=1024)
    read: bool = Field(default=True, strict=True)


@router.get('/{conversation_id}/messages/page')
def get_page(conversation_id: ConversationId, user: Authenticated, db: Database,
             limit: Annotated[int, Query(ge=1, le=100)] = 30,
             before: Annotated[str | None, Query(max_length=1024)] = None,
             after: Annotated[str | None, Query(max_length=1024)] = None):
    snapshot(db)
    require_membership(conversation_id, user.id, db)
    if before is not None and after is not None:
        raise HTTPException(422, detail='Choose one history direction')
    query = message_query().where(Message.conversation_id == conversation_id)
    if before is not None or after is not None:
        timestamp, message_id, _ = boundary(before if before is not None else after, conversation_id)
        query = query.where(older_than(timestamp, message_id) if before is not None else newer_than(timestamp, message_id))
    query = query.order_by(timeline_timestamp.asc(), Message.id.asc()) if after else query.order_by(timeline_timestamp.desc(), Message.id.desc())
    rows = list(db.execute(query.limit(limit)))
    if not after:
        rows.reverse()
    result = page_response(db, conversation_id, user.id, rows)
    if after:
        result['has_more'] = result['has_newer']
        result['next_cursor'] = message_cursor(rows[-1][0]) if rows and result['has_newer'] else None
    return result


@router.get('/{conversation_id}/messages/{message_id}/context')
def get_context(conversation_id: ConversationId, message_id: Annotated[int, Path(gt=0, lt=2**63)],
                user: Authenticated, db: Database):
    snapshot(db)
    require_membership(conversation_id, user.id, db)
    target = db.scalar(select(Message).where(Message.id == message_id, Message.conversation_id == conversation_id))
    if target is None:
        raise HTTPException(404, detail='Reply target unavailable')
    base = message_query().where(Message.conversation_id == conversation_id)
    older = list(db.execute(base.where(older_than(target.created_at, target.id)).order_by(timeline_timestamp.desc(), Message.id.desc()).limit(15)))
    newer = list(db.execute(base.where(newer_than(target.created_at, target.id)).order_by(timeline_timestamp.asc(), Message.id.asc()).limit(15)))
    middle = list(db.execute(base.where(Message.id == target.id)))
    return page_response(db, conversation_id, user.id, list(reversed(older)) + middle + newer)


@router.post('/{conversation_id}/sync')
def replay(conversation_id: ConversationId, data: SyncRequest, user: Authenticated, db: Database,
           after: Annotated[str, Query(max_length=1024)],
           limit: Annotated[int, Query(ge=1, le=100)] = 100):
    snapshot(db)
    require_membership(conversation_id, user.id, db)
    token = decode_cursor(after, 'sync', conversation_id)
    position = token.get('s')
    head, floor = state_bounds(db, conversation_id)
    if type(position) is not int or not 0 <= position <= head:
        raise HTTPException(422, detail='Invalid synchronization position')
    if position < floor:
        raise HTTPException(409, detail={'code': 'replay_gap', 'message': 'History recovery required'})
    events = list(db.scalars(select(ConversationEvent).where(
        ConversationEvent.conversation_id == conversation_id, ConversationEvent.id > position,
        ConversationEvent.id <= head).order_by(ConversationEvent.id).limit(limit + 1)))
    has_more = len(events) > limit
    events = events[:limit]
    ids = set(data.message_ids) | {event.message_id for event in events if event.message_id is not None}
    rows = list(db.execute(message_query().where(Message.conversation_id == conversation_id, Message.id.in_(ids)))) if ids else []
    present = {row[0].id for row in rows}
    # Missing IDs reveal no foreign message state: hydration always checks the
    # conversation, so foreign and nonexistent requested IDs are both missing.
    next_position = events[-1].id if has_more else head
    return {'events': [{'id': event.id, 'kind': event.kind, 'message_id': event.message_id} for event in events],
            'items': serialize_rows(db, rows, user.id), 'missing_ids': sorted(ids - present),
            'cursors': {row[0].id: message_cursor(row[0]) for row in rows},
            'has_more': has_more, 'next_cursor': cursor('sync', conversation_id, s=next_position),
            **snapshot_metadata(db, conversation_id, user.id)}


@router.post('/{conversation_id}/receipts')
def acknowledge_range(conversation_id: ConversationId, data: ReceiptRangeRequest,
                      background_tasks: BackgroundTasks, user: Authenticated, db: Database):
    require_membership(conversation_id, user.id, db)
    timestamp, message_id, token = boundary(data.through, conversation_id, 'read')
    if token.get('u') != user.id:
        raise HTTPException(422, detail='Invalid receipt boundary')
    eligible = select(Message.id).where(Message.conversation_id == conversation_id, Message.sender_id != user.id,
        ~newer_than(timestamp, message_id))
    now = datetime.now(UTC).replace(tzinfo=None)
    values = {'delivered_at': func.coalesce(MessageReceipt.delivered_at, now)}
    if data.read:
        values['read_at'] = func.coalesce(MessageReceipt.read_at, func.max(func.coalesce(MessageReceipt.delivered_at, now), now))
    changed = db.execute(update(MessageReceipt).where(MessageReceipt.recipient_id == user.id,
        MessageReceipt.message_id.in_(eligible),
        (MessageReceipt.read_at if data.read else MessageReceipt.delivered_at).is_(None)).values(**values)).rowcount
    if changed:
        record_event(db, conversation_id, 'receipts')
    member_ids = list(db.scalars(select(ConversationMember.user_id).where(ConversationMember.conversation_id == conversation_id)))
    db.commit()
    if changed:
        background_tasks.add_task(manager.broadcast, member_ids, {'type': 'conversation:receipts', 'data': {'conversation_id': conversation_id}})
    return {'changed': changed}
