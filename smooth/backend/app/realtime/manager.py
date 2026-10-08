import asyncio
from dataclasses import dataclass, field
from time import time
from typing import Any

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

    def register(self, user_id: int, socket: WebSocket, expires_at: float) -> Connection:
        connection = Connection(user_id, socket, expires_at)
        self.connections.setdefault(user_id, set()).add(connection)
        return connection

    def disconnect(self, connection: Connection) -> None:
        sockets = self.connections.get(connection.user_id)
        if sockets is not None:
            sockets.discard(connection)
            if not sockets:
                self.connections.pop(connection.user_id, None)

    async def expire(self, connection: Connection) -> None:
        async with connection.lock:
            try:
                await asyncio.wait_for(
                    connection.socket.send_json({"type": "auth:error"}), timeout=2
                )
                await asyncio.wait_for(connection.socket.close(code=4401), timeout=1)
            except (WebSocketDisconnect, RuntimeError, OSError, TimeoutError):
                pass
            finally:
                self.disconnect(connection)

    async def _deliver(self, connection: Connection, event: dict[str, Any]) -> None:
        try:
            async with connection.lock:
                if time() < connection.expires_at:
                    await asyncio.wait_for(connection.socket.send_json(event), timeout=2)
                    return
            await self.expire(connection)
        except (WebSocketDisconnect, RuntimeError, OSError, TimeoutError):
            self.disconnect(connection)
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
