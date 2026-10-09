"""Run with: python -m unittest discover -s tests -v (requires httpx2)."""
import os
import asyncio
import tempfile
import unittest
from time import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from unittest.mock import AsyncMock, patch

from anyio import create_task_group

# Isolate verification from the application's configured database and secret.
_database = tempfile.TemporaryDirectory()
os.environ.update(
    DATABASE_URL=f"sqlite:///{_database.name}/test.db",
    SECRET_KEY="phase8-test-secret-only-" * 3,
    ACCESS_TOKEN_EXPIRE_MINUTES="60",
    FRONTEND_ORIGIN="http://127.0.0.1:5173",
)

import jwt
from fastapi.testclient import TestClient
from sqlalchemy import func, select, inspect
from starlette.websockets import WebSocketDisconnect

from app.core.config import SECRET_KEY
from app.database.database import Base, SessionLocal, engine
from app.main import app
from app.models.message import Message
from app.models.conversation import Conversation
from app.models.conversation_member import ConversationMember
from app.models.message_receipt import MessageReceipt
from app.models.user import User
from app.realtime.manager import ConnectionManager, manager
from app.services.receipts import acknowledge_message, initialize_receipts


class Phase8Tests(unittest.TestCase):
    def setUp(self):
        Base.metadata.drop_all(engine)
        self.client = TestClient(app)
        self.client.__enter__()
        self.addCleanup(self.client.__exit__, None, None, None)
        self.users, self.tokens = {}, {}
        for name in ("alice", "bob", "charlie"):
            body = {"username": name, "password": "password123"}
            response = self.client.post("/api/auth/register", json=body)
            self.assertEqual(response.status_code, 201)
            self.users[name] = response.json()["id"]
            self.tokens[name] = self.client.post("/api/auth/login", json=body).json()["access_token"]
        response = self.client.post(f'/api/conversations/with/{self.users["bob"]}', headers=self.headers("alice"))
        self.assertEqual(response.status_code, 201)
        self.path = f'/api/conversations/{response.json()["id"]}/messages'

    def headers(self, name):
        return {"Authorization": f"Bearer {self.tokens[name]}"}

    def authenticate(self, socket, name):
        socket.send_json({"type": "auth", "token": self.tokens[name]})
        self.assertEqual(socket.receive_json(), {"type": "auth:ok"})
        return self.receive_type(socket, "presence:snapshot")

    def receive_type(self, socket, event_type):
        while True:
            event = socket.receive_json()
            if event["type"] == event_type:
                return event
            self.assertIn(event["type"], ("presence:update", "presence:snapshot"))

    def test_delivery_multiple_tabs_and_offline_history(self):
        with self.client.websocket_connect("/ws") as alice, self.client.websocket_connect("/ws") as bob, self.client.websocket_connect("/ws") as bob_tab:
            for socket, name in ((alice, "alice"), (bob, "bob"), (bob_tab, "bob")):
                self.authenticate(socket, name)
            for sender, content in (("alice", "hello bob"), ("bob", "hello alice")):
                response = self.client.post(self.path, headers=self.headers(sender), json={"content": content})
                self.assertEqual(response.status_code, 201)
                for socket in (alice, bob, bob_tab):
                    self.assertEqual(self.receive_type(socket, "message:new"), {"type": "message:new", "data": response.json()})
                with SessionLocal() as db:
                    self.assertIsNotNone(db.get(Message, response.json()["id"]))
        self.assertEqual(manager.connections, {})
        self.assertEqual(self.client.post(self.path, headers=self.headers("alice"), json={"content": "offline"}).status_code, 201)
        history = self.client.get(self.path, headers=self.headers("bob")).json()
        self.assertEqual([m["content"] for m in history], ["hello bob", "hello alice", "offline"])
        with SessionLocal() as db:
            self.assertEqual(db.scalar(select(func.count(Message.id))), 3)

    def test_invalid_authentication_and_timeout(self):
        payload = jwt.decode(self.tokens["alice"], SECRET_KEY, algorithms=["HS256"])
        expired = jwt.encode({**payload, "exp": 1}, SECRET_KEY, algorithm="HS256")
        modified = jwt.encode(payload, "wrong-signing-key" * 3, algorithm="HS256")
        deleted = self.tokens["charlie"]
        with SessionLocal() as db:
            db.delete(db.get(User, self.users["charlie"]))
            db.commit()
        for token in ("fake", expired, modified, deleted):
            with self.subTest(token_kind="rejected"), self.client.websocket_connect("/ws") as socket:
                socket.send_json({"type": "auth", "token": token})
                self.assertEqual(socket.receive_json(), {"type": "auth:error"})
                with self.assertRaises(WebSocketDisconnect) as closed:
                    socket.receive_json()
                self.assertEqual(closed.exception.code, 4401)
                self.assertEqual(manager.connections, {})
        with patch("app.api.realtime.AUTH_TIMEOUT_SECONDS", 0.05), self.client.websocket_connect("/ws") as socket:
            self.assertEqual(socket.receive_json(), {"type": "auth:error"})
        self.assertEqual(manager.connections, {})

    def test_http_regressions_and_no_broadcast_on_failed_commit(self):
        self.assertEqual(self.client.get("/").status_code, 200)
        for path in ("/api/auth/me", "/api/users", self.path):
            self.assertEqual(self.client.get(path).status_code, 401)
            self.assertEqual(self.client.get(path, headers=self.headers("alice")).status_code, 200)
        self.assertEqual(self.client.get("/api/users?search=BOB", headers=self.headers("alice")).json()[0]["username"], "bob")
        self.assertEqual(self.client.get(self.path, headers=self.headers("charlie")).status_code, 404)
        self.assertEqual(self.client.post(self.path, headers=self.headers("charlie"), json={"content": "forged"}).status_code, 404)
        self.assertEqual(self.client.post(self.path, headers=self.headers("alice"), json={"content": "  "}).status_code, 422)
        self.assertEqual(self.client.post(f'/api/conversations/with/{self.users["bob"]}', headers=self.headers("alice")).status_code, 200)
        with patch("app.api.conversations.manager.broadcast") as broadcast, patch("sqlalchemy.orm.Session.commit", side_effect=RuntimeError("commit failed")):
            with self.assertRaisesRegex(RuntimeError, "commit failed"):
                self.client.post(self.path, headers=self.headers("alice"), json={"content": "never persisted"})
            broadcast.assert_not_called()
        with SessionLocal() as db:
            self.assertEqual(db.scalar(select(func.count(Message.id))), 0)
            self.assertEqual(db.scalar(select(func.count(MessageReceipt.id))), 0)

    def test_socket_cannot_create_messages_and_origin_is_checked(self):
        with self.client.websocket_connect("/ws") as socket:
            self.authenticate(socket, "alice")
            socket.send_json({"type": "message:new", "data": {"sender_id": self.users["bob"], "content": "forged"}})
            with self.assertRaises(WebSocketDisconnect) as closed:
                socket.receive_json()
            self.assertEqual(closed.exception.code, 1008)
        with self.assertRaises(WebSocketDisconnect):
            with self.client.websocket_connect("/ws", headers={"origin": "https://other.example"}):
                pass
        with SessionLocal() as db:
            self.assertEqual(db.scalar(select(func.count(Message.id))), 0)

    def test_presence_transitions_snapshot_and_multiple_tabs(self):
        with self.client.websocket_connect("/ws") as alice:
            self.assertEqual(self.authenticate(alice, "alice")["data"], {"online_user_ids": [self.users["alice"]]})
            with self.client.websocket_connect("/ws") as bob:
                self.assertEqual(self.authenticate(bob, "bob")["data"], {"online_user_ids": [self.users["alice"], self.users["bob"]]})
                self.assertEqual(alice.receive_json(), {"type": "presence:update", "data": {"user_id": self.users["bob"], "status": "online"}})
                with self.client.websocket_connect("/ws") as second_tab:
                    self.authenticate(second_tab, "bob")
                    response = self.client.post(self.path, headers=self.headers("alice"), json={"content": "two tabs"})
                    # No duplicate online event was queued for Alice or Bob.
                    for socket in (alice, bob, second_tab):
                        self.assertEqual(socket.receive_json(), {"type": "message:new", "data": response.json()})
                response = self.client.post(self.path, headers=self.headers("alice"), json={"content": "one tab"})
                for socket in (alice, bob):
                    self.assertEqual(socket.receive_json(), {"type": "message:new", "data": response.json()})
            self.assertEqual(alice.receive_json(), {"type": "presence:update", "data": {"user_id": self.users["bob"], "status": "offline"}})
            with self.client.websocket_connect("/ws") as bob:
                self.authenticate(bob, "bob")
                self.assertEqual(alice.receive_json()["data"], {"user_id": self.users["bob"], "status": "online"})

    def test_typing_authorization_safe_events_and_no_writes(self):
        conversation_id = int(self.path.split("/")[3])
        with self.client.websocket_connect("/ws") as alice, self.client.websocket_connect("/ws") as bob:
            self.authenticate(alice, "alice")
            self.authenticate(bob, "bob")
            self.assertEqual(alice.receive_json()["type"], "presence:update")
            with patch("sqlalchemy.orm.Session.commit", side_effect=AssertionError("typing must not commit")):
                for event_type in ("typing:start", "typing:stop"):
                    alice.send_json({"type": event_type, "conversation_id": conversation_id, "user_id": self.users["charlie"]})
                    self.assertEqual(bob.receive_json(), {"type": event_type, "data": {"conversation_id": conversation_id, "user_id": self.users["alice"]}})
            with self.client.websocket_connect("/ws") as charlie:
                self.authenticate(charlie, "charlie")
                for socket in (alice, bob):
                    self.assertEqual(socket.receive_json()["type"], "presence:update")
                charlie.send_json({"type": "typing:start", "conversation_id": conversation_id})
                with self.assertRaises(WebSocketDisconnect) as closed:
                    charlie.receive_json()
                self.assertEqual(closed.exception.code, 1008)
                for socket in (alice, bob):
                    # The next event is offline presence, never unauthorized typing.
                    self.assertEqual(socket.receive_json(), {"type": "presence:update", "data": {"user_id": self.users["charlie"], "status": "offline"}})
            response = self.client.post(self.path, headers=self.headers("alice"), json={"content": "still works"})
            for socket in (alice, bob):
                # Also proves typing was not echoed to Alice.
                self.assertEqual(socket.receive_json(), {"type": "message:new", "data": response.json()})

    def test_unauthenticated_and_malformed_typing(self):
        with self.client.websocket_connect("/ws") as socket:
            socket.send_json({"type": "typing:start", "conversation_id": 1})
            self.assertEqual(socket.receive_json(), {"type": "auth:error"})
        for conversation_id in (True, 0, -1, "1", 2**63, None, 99999):
            with self.subTest(conversation_id=conversation_id), self.client.websocket_connect("/ws") as socket:
                self.authenticate(socket, "alice")
                socket.send_json({"type": "typing:start", "conversation_id": conversation_id})
                with self.assertRaises(WebSocketDisconnect) as closed:
                    socket.receive_json()
                self.assertEqual(closed.exception.code, 1008)

    def test_receipt_transitions_status_authorization_and_idempotency(self):
        saved = self.client.post(self.path, headers=self.headers("alice"), json={"content": "receipts"}).json()
        self.assertIsNone(saved["delivered_at"])
        self.assertIsNone(saved["read_at"])
        message_id = saved["id"]
        for non_recipient in ("alice", "charlie"):
            for read in (False, True):
                self.assertIsNone(acknowledge_message(message_id, self.users[non_recipient], read))
        untouched = self.client.get(self.path, headers=self.headers("alice")).json()[0]
        self.assertIsNone(untouched["delivered_at"])
        self.assertIsNone(untouched["read_at"])
        with SessionLocal() as db:
            receipt = db.scalar(select(MessageReceipt).where(MessageReceipt.message_id == message_id))
            self.assertEqual(receipt.recipient_id, self.users["bob"])
            self.assertEqual(db.scalar(select(func.count(MessageReceipt.id))), 1)
        with self.client.websocket_connect("/ws") as alice, self.client.websocket_connect("/ws") as bob:
            self.authenticate(alice, "alice")
            self.authenticate(bob, "bob")
            alice.receive_json()  # Bob online.
            bob.send_json({"type": "message:delivered", "message_id": message_id, "recipient_id": self.users["charlie"]})
            delivered = alice.receive_json()
            self.assertEqual(delivered["type"], "message:status")
            self.assertEqual(set(delivered["data"]), {"message_id", "delivered_at", "read_at"})
            self.assertIsNotNone(delivered["data"]["delivered_at"])
            self.assertIsNone(delivered["data"]["read_at"])
            bob.send_json({"type": "message:read", "message_id": message_id})
            read = alice.receive_json()["data"]
            self.assertEqual(read["delivered_at"], delivered["data"]["delivered_at"])
            self.assertIsNotNone(read["read_at"])
            for event_type in ("message:delivered", "message:read"):
                bob.send_json({"type": event_type, "message_id": message_id})
                alice.send_json({"type": event_type, "message_id": message_id})
            # A later authorized event proves duplicate acknowledgements neither
            # changed status nor generated extra status events.
            bob.send_json({"type": "typing:start", "conversation_id": int(self.path.split('/')[3])})
            self.assertEqual(alice.receive_json()["type"], "typing:start")
            conversation = self.client.post(f'/api/conversations/with/{self.users["alice"]}', headers=self.headers("charlie")).json()
            with self.client.websocket_connect("/ws") as charlie:
                self.authenticate(charlie, "charlie")
                alice.receive_json()
                for event_type in ("message:delivered", "message:read"):
                    for invalid_id in (message_id, True, None, "1", -1, 0, 2**63, 99999):
                        charlie.send_json({"type": event_type, "message_id": invalid_id, "recipient_id": self.users["bob"]})
                charlie.send_json({"type": "typing:start", "conversation_id": conversation["id"]})
                self.assertEqual(alice.receive_json()["type"], "typing:start")
        self.assertEqual(self.client.get(self.path, headers=self.headers("alice")).json()[0]["read_at"], read["read_at"])
        for user in ("alice", "charlie"):
            self.assertIsNone(acknowledge_message(message_id, self.users[user], True))
        self.assertEqual(self.client.get(self.path, headers=self.headers("alice")).json()[0]["delivered_at"], read["delivered_at"])

    def test_concurrent_tabs_read_implies_delivered(self):
        message_id = self.client.post(self.path, headers=self.headers("alice"), json={"content": "multiple tabs"}).json()["id"]
        with ThreadPoolExecutor(max_workers=4) as threads:
            list(threads.map(lambda read: acknowledge_message(message_id, self.users["bob"], read), [True, False] * 4))
        history = self.client.get(self.path, headers=self.headers("alice")).json()[0]
        self.assertIsNotNone(history["delivered_at"])
        self.assertIsNotNone(history["read_at"])
        self.assertGreaterEqual(history["read_at"], history["delivered_at"])
        for read in (False, True):
            self.assertIsNone(acknowledge_message(message_id, self.users["bob"], read))
        self.assertEqual(self.client.get(self.path, headers=self.headers("alice")).json()[0], history)

    def test_existing_sqlite_table_compatibility_and_receipt_backfill(self):
        message_id = self.client.post(self.path, headers=self.headers("alice"), json={"content": "legacy message"}).json()["id"]
        def columns():
            return [{**column, "type": str(column["type"])} for column in inspect(engine).get_columns("messages")]

        original_columns = columns()
        MessageReceipt.__table__.drop(engine)  # Only the isolated test database.
        Base.metadata.create_all(engine)
        initialize_receipts()
        self.assertEqual(columns(), original_columns)
        with SessionLocal() as db:
            receipt = db.scalar(select(MessageReceipt))
            self.assertEqual(receipt.message_id, message_id)
            self.assertEqual(receipt.recipient_id, self.users["bob"])
            self.assertIsNone(receipt.delivered_at)
            self.assertIsNone(receipt.read_at)
        acknowledge_message(message_id, self.users["bob"], True)
        initialize_receipts()
        with SessionLocal() as db:
            self.assertEqual(db.scalar(select(func.count(MessageReceipt.id))), 1)
        self.assertIsNotNone(self.client.get(self.path, headers=self.headers("alice")).json()[0]["read_at"])

    def test_recent_conversations_membership_ordering_and_latest_message(self):
        endpoint = "/api/conversations"
        self.assertEqual(self.client.get(endpoint).status_code, 401)
        self.assertEqual(self.client.get(endpoint, headers={"Authorization": "Bearer fake"}).status_code, 401)
        self.assertEqual(self.client.get(endpoint, headers=self.headers("charlie")).json(), [])
        bob_id = int(self.path.split('/')[3])
        empty = self.client.get(endpoint, headers=self.headers("alice")).json()[0]
        self.assertIsNone(empty["last_message"])
        self.assertEqual(empty["other_user"]["id"], self.users["bob"])
        charlie_id = self.client.post(f'/api/conversations/with/{self.users["charlie"]}', headers=self.headers("alice")).json()["id"]
        unrelated_id = self.client.post(f'/api/conversations/with/{self.users["charlie"]}', headers=self.headers("bob")).json()["id"]
        first = self.client.post(f'/api/conversations/{charlie_id}/messages', headers=self.headers("alice"), json={"content": "first"}).json()
        latest = self.client.post(f'/api/conversations/{charlie_id}/messages', headers=self.headers("alice"), json={"content": "same timestamp latest ID"}).json()
        bob_latest = self.client.post(self.path, headers=self.headers("bob"), json={"content": "newer Bob activity"}).json()
        older = self.client.post(self.path, headers=self.headers("alice"), json={"content": "higher ID but earlier time"}).json()
        with SessionLocal() as db:
            for message_id, day in ((first["id"], 1), (latest["id"], 1), (bob_latest["id"], 2), (older["id"], 1)):
                db.get(Message, message_id).created_at = datetime(2026, 10, day)
            db.commit()
        rows = self.client.get(endpoint, headers=self.headers("alice")).json()
        self.assertEqual([row["id"] for row in rows], [bob_id, charlie_id])
        self.assertNotIn(unrelated_id, [row["id"] for row in rows])
        self.assertEqual(rows[0]["last_message"]["id"], bob_latest["id"])
        self.assertEqual(rows[1]["last_message"]["id"], latest["id"])
        self.assertEqual(rows[0]["updated_at"], rows[0]["last_message"]["created_at"])
        self.assertEqual(set(rows[0]), {"id", "other_user", "last_message", "updated_at"})
        self.assertEqual(set(rows[0]["other_user"]), {"id", "username", "created_at"})
        self.assertEqual(set(rows[0]["last_message"]), {"id", "sender_id", "content", "created_at"})
        with SessionLocal() as db:
            db.get(Message, latest["id"]).created_at = datetime(2026, 10, 3)
            db.commit()
        self.assertEqual(self.client.get(endpoint, headers=self.headers("alice")).json()[0]["id"], charlie_id)

    def test_recent_conversations_limit_and_empty_order(self):
        with SessionLocal() as db:
            for index in range(52):
                other_user = User(username=f"recent_{index}", password_hash="unused-test-hash")
                db.add(other_user)
                db.flush()
                low_id, high_id = sorted((self.users["alice"], other_user.id))
                conversation = Conversation(user_low_id=low_id, user_high_id=high_id)
                db.add(conversation)
                db.flush()
                db.add_all([ConversationMember(conversation_id=conversation.id, user_id=user_id) for user_id in (low_id, high_id)])
            db.commit()
        rows = self.client.get('/api/conversations', headers=self.headers("alice")).json()
        self.assertEqual(len(rows), 50)
        self.assertTrue(all(row["last_message"] is None for row in rows))
        self.assertEqual([row["id"] for row in rows], sorted([row["id"] for row in rows], reverse=True))
        self.assertTrue(all(row["other_user"]["id"] != self.users["alice"] for row in rows))
        self.assertEqual(self.client.get('/api/conversations', headers=self.headers("charlie")).json(), [])


class ManagerCleanupTests(unittest.IsolatedAsyncioTestCase):
    async def test_failed_send_removes_only_failed_tab_and_expiry_goes_offline(self):
        connections = ConnectionManager()
        observer, first_tab, second_tab = AsyncMock(), AsyncMock(), AsyncMock()
        await connections.register(1, observer, time() + 60)
        await connections.register(2, first_tab, time() + 60)
        remaining = await connections.register(2, second_tab, time() + 60)
        observer.send_json.reset_mock()
        first_tab.send_json.side_effect = OSError("disconnected")
        await connections.send_to_user(2, {"type": "message:new"})
        self.assertEqual(len(connections.connections[2]), 1)
        observer.send_json.assert_not_called()
        await connections.expire(remaining)
        self.assertEqual(connections.online_user_ids(), [1])
        observer.send_json.assert_awaited_once_with({"type": "presence:update", "data": {"user_id": 2, "status": "offline"}})
        await connections.disconnect(remaining)
        self.assertEqual(observer.send_json.await_count, 1)

    async def test_cancelled_registration_is_removed(self):
        connections = ConnectionManager()
        socket = AsyncMock()
        observer = AsyncMock()
        await connections.register(2, observer, time() + 60)
        observer.send_json.reset_mock()
        sending = asyncio.Event()

        async def blocked_send(_event):
            sending.set()
            await asyncio.Event().wait()

        socket.send_json.side_effect = blocked_send
        async with create_task_group() as tasks:
            tasks.start_soon(connections.register, 1, socket, time() + 60)
            await sending.wait()
            tasks.cancel_scope.cancel()
        self.assertEqual(connections.online_user_ids(), [2])
        self.assertEqual([call.args[0] for call in observer.send_json.await_args_list], [
            {"type": "presence:update", "data": {"user_id": 1, "status": "online"}},
            {"type": "presence:update", "data": {"user_id": 1, "status": "offline"}},
        ])


if __name__ == "__main__":
    unittest.main()
