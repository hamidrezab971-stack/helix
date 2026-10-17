"""Atomic send intent identity, including retries after edits and deletion."""
from hashlib import sha256
import json
from fastapi import HTTPException
from sqlalchemy import select
from app.models.message import Message, MessageSendIntent
from app.schemas.conversations import MessageResponse


def fingerprint(conversation_id, content, reply_id, image_digest=None):
    value = json.dumps([conversation_id, content, reply_id, image_digest], ensure_ascii=False, separators=(',', ':'))
    return sha256(value.encode('utf-8')).hexdigest()


def replay(db, sender_id, client_id, digest):
    if client_id is None:
        return None
    intent = db.get(MessageSendIntent, (sender_id, client_id))
    if intent is None:
        return None
    if intent.fingerprint != digest:
        raise HTTPException(409, detail='Client message ID was reused for a different message')
    # Return current authoritative state, preserving edits, replies and receipts.
    from app.services.sync import message_query, serialize_rows
    from app.services.visibility import visible_message
    rows = list(db.execute(message_query().where(Message.id == intent.message_id, visible_message(sender_id))))
    if not rows:
        raise HTTPException(410, detail='This message was already sent and deleted')
    return MessageResponse.model_validate(serialize_rows(db, rows, sender_id)[0])


def remember(db, message, digest):
    if message.client_message_id is not None:
        db.add(MessageSendIntent(sender_id=message.sender_id, client_message_id=message.client_message_id,
                                 message_id=message.id, fingerprint=digest))
        db.flush()
