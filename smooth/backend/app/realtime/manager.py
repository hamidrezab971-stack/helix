import asyncio
from dataclasses import dataclass, field
from time import time
from typing import Any

from anyio import CancelScope
from fastapi import WebSocket, WebSocketDisconnect


@dataclass(eq=False)
class Connection:
    user_id: int
    socket: WebSocket
    expires_at: float
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


class ConnectionManager:
    def __init__(self) -> None:
        self.connections: dict[int, set[Connection]] = {}

    def online_user_ids(self) -> list[int]:
        return sorted(self.connections)

    async def presence_update(self, user_id: int, status: str) -> None:
        await self.broadcast(
            self.online_user_ids(),
            {"type": "presence:update", "data": {"user_id": user_id, "status": status}},
        )

    async def register(self, user_id: int, socket: WebSocket, expires_at: float) -> Connection:
        was_online = user_id in self.connections
        connection = Connection(user_id, socket, expires_at)
        self.connections.setdefault(user_id, set()).add(connection)
        try:
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
                    await self.presence_update(connection.user_id, "offline")

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
        # Snapshot the set: disconnects may happen during a send.
        sockets = tuple(self.connections.get(user_id, ()))
        await asyncio.gather(*(self._deliver(connection, event) for connection in sockets))

    async def broadcast(self, user_ids: list[int], event: dict[str, Any]) -> None:
        await asyncio.gather(*(self.send_to_user(user_id, event) for user_id in set(user_ids)))


manager = ConnectionManager()
