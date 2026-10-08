import asyncio
from time import time

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from starlette.concurrency import run_in_threadpool

from app.core.auth import authenticate_access_token
from app.core.config import FRONTEND_ORIGIN
from app.database.database import SessionLocal
from app.realtime.manager import manager

router = APIRouter()
AUTH_TIMEOUT_SECONDS = 5


def authenticate_socket(token: str) -> tuple[int, float]:
    # Authentication needs a session only for this lookup, not the socket lifetime.
    with SessionLocal() as db:
        user, expires_at = authenticate_access_token(token, db)
        return user.id, expires_at


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
        connection = manager.register(user_id, socket, expires_at)
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
            # This socket delivers events only; clients create messages over HTTP.
            await socket.close(code=1008)
            return
    except (WebSocketDisconnect, RuntimeError, OSError):
        pass
    finally:
        if connection is not None:
            manager.disconnect(connection)
