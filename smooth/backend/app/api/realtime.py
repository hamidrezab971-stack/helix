import asyncio
import json
from time import time

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from starlette.concurrency import run_in_threadpool
from sqlalchemy import select

from app.api.conversations import require_membership
from app.core.auth import authenticate_access_token
from app.core.config import FRONTEND_ORIGIN
from app.database.database import SessionLocal
from app.models.conversation import Conversation
from app.models.conversation_member import ConversationMember
from app.realtime.manager import manager
from app.services.receipts import acknowledge_message

router = APIRouter()
AUTH_TIMEOUT_SECONDS = 5


def authenticate_socket(token: str) -> tuple[int, float]:
    # Authentication needs a session only for this lookup, not the socket lifetime.
    with SessionLocal() as db:
        user, expires_at = authenticate_access_token(token, db)
        return user.id, expires_at


def typing_recipients(conversation_id: int, user_id: int) -> list[int]:
    # Only reads, with a fresh session per event rather than per socket lifetime.
    with SessionLocal() as db:
        if db.get(Conversation, conversation_id) is None:
            raise HTTPException(status_code=404, detail="Conversation not found")
        require_membership(conversation_id, user_id, db)
        return list(db.scalars(select(ConversationMember.user_id).where(
            ConversationMember.conversation_id == conversation_id,
            ConversationMember.user_id != user_id,
        )))


@router.websocket("/ws")
async def websocket_endpoint(socket: WebSocket) -> None:
    origin = socket.headers.get("origin")
    if origin is not None and origin != FRONTEND_ORIGIN:
        await socket.close(code=1008)
        return

    await socket.accept()
    connection = None
    try:
        try:
            auth = await asyncio.wait_for(socket.receive_json(), AUTH_TIMEOUT_SECONDS)
            if not isinstance(auth, dict) or auth.get("type") != "auth":
                raise ValueError
            token = auth.get("token")
            if not isinstance(token, str) or not token or len(token) > 8192:
                raise ValueError
            user_id, expires_at = await run_in_threadpool(authenticate_socket, token)
        except (TimeoutError, ValueError, KeyError, TypeError, HTTPException):
            await socket.send_json({"type": "auth:error"})
            await socket.close(code=4401)
            return

        await socket.send_json({"type": "auth:ok"})
        connection = await manager.register(user_id, socket, expires_at)
        while True:
            try:
                frame = await asyncio.wait_for(
                    socket.receive(), timeout=max(0, expires_at - time())
                )
            except TimeoutError:
                await manager.expire(connection)
                return
            if frame["type"] == "websocket.disconnect":
                return
            if time() >= expires_at:
                await manager.expire(connection)
                return
            try:
                event = json.loads(frame.get("text", ""))
                if isinstance(event, dict) and event.get("type") in ("message:delivered", "message:read"):
                    message_id = event.get("message_id")
                    # Malformed, missing and forged receipt IDs are ignored;
                    # they never change another user's receipt or crash a socket.
                    if type(message_id) is not int or not 0 < message_id < 2**63:
                        continue
                    changed = await run_in_threadpool(
                        acknowledge_message, message_id, user_id, event["type"] == "message:read",
                    )
                    if changed is not None:
                        sender_id, data = changed
                        await manager.send_to_user(sender_id, {"type": "message:status", "data": data})
                    continue
                if not isinstance(event, dict) or event.get("type") not in ("typing:start", "typing:stop"):
                    raise ValueError
                conversation_id = event.get("conversation_id")
                if type(conversation_id) is not int or not 0 < conversation_id < 2**63:
                    raise ValueError
                recipients = await run_in_threadpool(typing_recipients, conversation_id, user_id)
            except (ValueError, TypeError, HTTPException):
                # Generic policy close for malformed or unauthorized events.
                await socket.close(code=1008)
                return
            if time() >= expires_at:
                await manager.expire(connection)
                return
            await manager.broadcast(recipients, {
                "type": event["type"],
                "data": {"conversation_id": conversation_id, "user_id": user_id},
            })
    except (WebSocketDisconnect, RuntimeError, OSError):
        pass
    finally:
        if connection is not None:
            await manager.disconnect(connection)
