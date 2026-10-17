import asyncio
import logging
from dataclasses import dataclass, field
from time import time, monotonic
from typing import Any

from anyio import CancelScope
from fastapi import WebSocket, WebSocketDisconnect
from starlette.concurrency import run_in_threadpool
from app.services.presence import persist_seen, presence_recipients


@dataclass(eq=False)
class Connection:
    user_id: int
    socket: WebSocket
    expires_at: float
    detailed_presence: bool = False
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


class ConnectionManager:
    def __init__(self, durable=False) -> None:
        self.durable = durable
        self.last_persisted = {}
        self.connections: dict[int, set[Connection]] = {}

    def online_user_ids(self) -> list[int]:
        return sorted(self.connections)

    async def touch(self, user_id: int, final=False):
        if not self.durable:
            return None
        now = monotonic()
        if not final and now - self.last_persisted.get(user_id, -60) < 60:
            return None
        self.last_persisted[user_id] = now
        try:
            return await run_in_threadpool(persist_seen, user_id)
        except Exception:
            logging.getLogger(__name__).exception("Unable to persist presence timestamp")
            return None

    async def presence_update(self, user_id: int, status: str, last_seen_at=None) -> None:
        peers = set()
        if last_seen_at:
            try:
                peers = set(await run_in_threadpool(presence_recipients, user_id))
            except Exception:
                # Membership lookup failures may suppress details, never expand them.
                logging.getLogger(__name__).exception("Unable to scope presence update")
        for observer in tuple(self.connections):
            for connection in tuple(self.connections.get(observer, ())):
                data = {"user_id": user_id, "status": status}
                if last_seen_at and observer in peers and connection.detailed_presence:
                    data['last_seen_at'] = last_seen_at
                await self._deliver(connection, {"type": "presence:update", "data": data})

    async def register(self, user_id: int, socket: WebSocket, expires_at: float, detailed_presence=False) -> Connection:
        was_online = user_id in self.connections
        connection = Connection(user_id, socket, expires_at, detailed_presence)
        self.connections.setdefault(user_id, set()).add(connection)
        try:
            await self.touch(user_id)
            if not was_online:
                await self.presence_update(user_id, "online")
            await self._deliver(connection, {
                "type": "presence:snapshot",
                "data": {"online_user_ids": self.online_user_ids()},
            })
        except BaseException:
            # The endpoint cannot clean up a registration that never returned
            # (for example, cancellation while sending the initial snapshot).
            await self.disconnect(connection)
            raise
        return connection

    async def disconnect(self, connection: Connection) -> None:
        # ASGI teardown can cancel the receive task. Complete the transition
        # once we remove the socket, including notifying remaining clients.
        with CancelScope(shield=True):
            sockets = self.connections.get(connection.user_id)
            if sockets is not None and connection in sockets:
                sockets.remove(connection)
                if not sockets:
                    self.connections.pop(connection.user_id, None)
                    stamp = await self.touch(connection.user_id, final=True)
                    # A new tab may authenticate while persistence awaits I/O.
                    if connection.user_id not in self.connections:
                        await self.presence_update(connection.user_id, "offline", stamp)
                        self.last_persisted.pop(connection.user_id, None)

    async def expire(self, connection: Connection) -> None:
        async with connection.lock:
            try:
                await asyncio.wait_for(
                    connection.socket.send_json({"type": "auth:error"}), timeout=2
                )
                await asyncio.wait_for(connection.socket.close(code=4401), timeout=1)
            except (WebSocketDisconnect, RuntimeError, OSError, TimeoutError):
                pass
        # Presence delivery must happen outside the socket's send lock.
        await self.disconnect(connection)

    async def _deliver(self, connection: Connection, event: dict[str, Any]) -> None:
        try:
            async with connection.lock:
                if time() < connection.expires_at:
                    await asyncio.wait_for(connection.socket.send_json(event), timeout=2)
                    return
            await self.expire(connection)
        except (WebSocketDisconnect, RuntimeError, OSError, TimeoutError):
            await self.disconnect(connection)
            try:
                await asyncio.wait_for(connection.socket.close(code=1011), timeout=1)
            except (WebSocketDisconnect, RuntimeError, OSError, TimeoutError):
                pass

    async def send_to_user(self, user_id: int, event: dict[str, Any]) -> None:
        if self.durable and event.get('type', '').startswith('message:'):
            from app.services.visibility import private_message_event
            event = await run_in_threadpool(private_message_event, user_id, event)
            if event is None:
                return
        # Snapshot the set: disconnects may happen during a send.
        sockets = tuple(self.connections.get(user_id, ()))
        await asyncio.gather(*(self._deliver(connection, event) for connection in sockets))

    async def broadcast(self, user_ids: list[int], event: dict[str, Any]) -> None:
        await asyncio.gather(*(self.send_to_user(user_id, event) for user_id in set(user_ids)))


manager = ConnectionManager(durable=True)
