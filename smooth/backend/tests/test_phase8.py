"""Run with: python -m unittest discover -s tests -v (requires httpx2)."""
import os
import asyncio
import tempfile
import unittest
from io import BytesIO
import struct
import zlib
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
    UPLOAD_DIR=f"{_database.name}/uploads",
)

import jwt
from fastapi.testclient import TestClient
from sqlalchemy import func, select, inspect
from starlette.websockets import WebSocketDisconnect
from PIL import Image

from app.core.config import SECRET_KEY
from app.database.database import Base, SessionLocal, engine
from app.main import app
from app.models.message import Message
from app.models.conversation import Conversation
from app.models.conversation_member import ConversationMember
from app.models.message_receipt import MessageReceipt
from app.models.message_edit import MessageEdit
from app.models.message_attachment import MessageAttachment
from app.services.images import IMAGE_MESSAGE_SENTINEL, MAX_IMAGE_BYTES, image_path
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
        self.assertEqual(set(rows[0]), {"id", "other_user", "last_message", "updated_at", "unread_count"})
        self.assertEqual(set(rows[0]["other_user"]), {"id", "username", "created_at"})
        self.assertEqual(set(rows[0]["last_message"]), {"id", "sender_id", "content", "created_at", "attachment"})
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

    def test_unread_counts_receipts_isolation_and_restart(self):
        conversation_id = int(self.path.split('/')[3])

        def count(name):
            rows = self.client.get('/api/conversations', headers=self.headers(name)).json()
            return next(row['unread_count'] for row in rows if row['id'] == conversation_id)

        self.assertEqual(count('alice'), 0)
        self.assertEqual(count('bob'), 0)

        messages = []
        for index in range(3):
            message = self.client.post(self.path, headers=self.headers('bob'), json={'content': f'unread {index}'}).json()
            messages.append(message)
            self.assertEqual(count('alice'), index + 1)
            self.assertEqual(count('bob'), 0)
        # Delivery alone is still unread; forged reads cannot clear it.
        acknowledge_message(messages[0]['id'], self.users['alice'], False)
        acknowledge_message(messages[0]['id'], self.users['charlie'], True)
        self.assertEqual(count('alice'), 3)
        unrelated = self.client.post(f'/api/conversations/with/{self.users["charlie"]}', headers=self.headers('bob')).json()['id']
        self.client.post(f'/api/conversations/{unrelated}/messages', headers=self.headers('charlie'), json={'content': 'not Alice'})
        self.assertEqual(count('alice'), 3)
        self.assertEqual(count('bob'), 0)
        # Fresh connections and startup backfill use persisted receipts.
        engine.dispose()
        initialize_receipts()
        self.assertEqual(count('alice'), 3)
        with self.client.websocket_connect('/ws') as sender, self.client.websocket_connect('/ws') as reader, self.client.websocket_connect('/ws') as other_tab:
            self.authenticate(sender, 'bob')
            self.authenticate(reader, 'alice')
            self.authenticate(other_tab, 'alice')
            for message in messages:
                reader.send_json({'type': 'message:read', 'message_id': message['id']})
                events = [self.receive_type(socket, 'message:status') for socket in (sender, reader, other_tab)]
                self.assertEqual(events[0], events[1])
                self.assertEqual(events[1], events[2])
                self.assertIsNotNone(events[0]['data']['read_at'])
            self.assertEqual(count('alice'), 0)
        for message in messages:
            self.assertIsNone(acknowledge_message(message['id'], self.users['alice'], True))
        self.assertEqual(count('alice'), 0)
        self.assertEqual(count('bob'), 0)


    def test_edit_repeated_effective_content_receipts_and_realtime(self):
        original = self.client.post(self.path, headers=self.headers('alice'), json={'content': 'Hello Bbo'}).json()
        message_id = original['id']
        acknowledge_message(message_id, self.users['bob'], True)
        receipt_before = self.client.get(self.path, headers=self.headers('alice')).json()[0]
        with self.client.websocket_connect('/ws') as alice, self.client.websocket_connect('/ws') as bob, self.client.websocket_connect('/ws') as alice_tab:
            for socket, name in ((alice, 'alice'), (bob, 'bob'), (alice_tab, 'alice')):
                self.authenticate(socket, name)
            response = self.client.patch(f'/api/messages/{message_id}', headers=self.headers('alice'), json={'content': '  Hello Bob  '})
            self.assertEqual(response.status_code, 200)
            edited = response.json()
            self.assertEqual(edited['content'], 'Hello Bob')
            self.assertIsNotNone(edited['edited_at'])
            for field in ('created_at', 'delivered_at', 'read_at'):
                self.assertEqual(edited[field], receipt_before[field])
            for socket in (alice, bob, alice_tab):
                self.assertEqual(self.receive_type(socket, 'message:updated'), {'type': 'message:updated', 'data': edited})
        with SessionLocal() as db:
            self.assertEqual(db.get(Message, message_id).content, 'Hello Bbo')
            edit_id = db.scalar(select(MessageEdit.id))
        second = self.client.patch(f'/api/messages/{message_id}', headers=self.headers('alice'), json={'content': 'Second edit'}).json()
        self.assertGreaterEqual(second['edited_at'], edited['edited_at'])
        with SessionLocal() as db:
            self.assertEqual(db.scalar(select(func.count(MessageEdit.id))), 1)
            self.assertEqual(db.scalar(select(MessageEdit.id)), edit_id)
        engine.dispose()
        self.assertEqual(self.client.get(self.path, headers=self.headers('bob')).json()[0], second)
        row = self.client.get('/api/conversations', headers=self.headers('alice')).json()[0]
        self.assertEqual(row['last_message']['content'], 'Second edit')
        self.assertEqual(row['updated_at'], original['created_at'])

    def test_mutation_authorization_validation_and_no_failed_broadcast(self):
        message_id = self.client.post(self.path, headers=self.headers('alice'), json={'content': 'Protected'}).json()['id']
        path = f'/api/messages/{message_id}'
        for method in ('patch', 'delete'):
            request = getattr(self.client, method)
            body = {'json': {'content': 'forged', 'sender_id': self.users['alice']}} if method == 'patch' else {}
            self.assertEqual(request(path, **body).status_code, 401)
            for name in ('bob', 'charlie'):
                self.assertEqual(request(path, headers=self.headers(name), **body).status_code, 404)
            for invalid_id in ('0', '-1', 'oops', str(2**63)):
                self.assertEqual(request(f'/api/messages/{invalid_id}', headers=self.headers('alice'), **body).status_code, 422)
            self.assertEqual(request('/api/messages/99999', headers=self.headers('alice'), **body).status_code, 404)
        for content in ('', '   ', 'x' * 2001):
            self.assertEqual(self.client.patch(path, headers=self.headers('alice'), json={'content': content}).status_code, 422)
        for method in ('patch', 'delete'):
            with patch('app.api.messages.manager.broadcast') as broadcast, patch('sqlalchemy.orm.Session.commit', side_effect=RuntimeError('commit failed')):
                with self.assertRaisesRegex(RuntimeError, 'commit failed'):
                    getattr(self.client, method)(path, headers=self.headers('alice'), **({'json': {'content': 'never committed'}} if method == 'patch' else {}))
                broadcast.assert_not_called()
        self.assertEqual(self.client.get(self.path, headers=self.headers('alice')).json()[0]['content'], 'Protected')
        with SessionLocal() as db:
            self.assertEqual(db.scalar(select(func.count(MessageEdit.id))), 0)
            self.assertEqual(db.scalar(select(func.count(MessageReceipt.id))), 1)
        for method in ('PATCH', 'DELETE'):
            preflight = self.client.options(path, headers={'Origin': 'http://127.0.0.1:5173', 'Access-Control-Request-Method': method, 'Access-Control-Request-Headers': 'authorization,content-type'})
            self.assertEqual(preflight.status_code, 200)
        with SessionLocal() as db:
            member = db.scalar(select(ConversationMember).where(ConversationMember.conversation_id == int(self.path.split('/')[3]), ConversationMember.user_id == self.users['alice']))
            db.delete(member)
            db.commit()
        self.assertEqual(self.client.patch(path, headers=self.headers('alice'), json={'content': 'no longer a member'}).status_code, 404)
        self.assertEqual(self.client.delete(path, headers=self.headers('alice')).status_code, 404)

    def test_delete_cleanup_unread_preview_fallback_and_stable_ids(self):
        messages = [self.client.post(self.path, headers=self.headers('bob'), json={'content': f'Unread {index}'}).json() for index in range(3)]
        message_id = messages[-1]['id']
        self.client.patch(f'/api/messages/{message_id}', headers=self.headers('bob'), json={'content': 'Edited unread'})
        with self.client.websocket_connect('/ws') as alice, self.client.websocket_connect('/ws') as bob:
            self.authenticate(alice, 'alice')
            self.authenticate(bob, 'bob')
            response = self.client.delete(f'/api/messages/{message_id}', headers=self.headers('bob'))
            self.assertEqual(response.status_code, 204)
            self.assertEqual(response.content, b'')
            expected = {'type': 'message:deleted', 'data': {'message_id': message_id, 'conversation_id': int(self.path.split('/')[3])}}
            for socket in (alice, bob):
                self.assertEqual(self.receive_type(socket, 'message:deleted'), expected)
        with SessionLocal() as db:
            self.assertIsNone(db.get(Message, message_id))
            self.assertIsNone(db.scalar(select(MessageReceipt).where(MessageReceipt.message_id == message_id)))
            self.assertIsNone(db.scalar(select(MessageEdit).where(MessageEdit.message_id == message_id)))
        row = self.client.get('/api/conversations', headers=self.headers('alice')).json()[0]
        self.assertEqual(row['unread_count'], 2)
        self.assertEqual(row['last_message']['id'], messages[1]['id'])
        for message in messages[:2]:
            self.client.delete(f'/api/messages/{message["id"]}', headers=self.headers('bob'))
        self.assertEqual(self.client.get(self.path, headers=self.headers('alice')).json(), [])
        row = self.client.get('/api/conversations', headers=self.headers('alice')).json()[0]
        self.assertIsNone(row['last_message'])
        self.assertEqual(row['unread_count'], 0)
        engine.dispose()
        saved = self.client.post(self.path, headers=self.headers('bob'), json={'content': 'New identity'}).json()
        self.assertGreater(saved['id'], message_id)
        self.assertIsNone(acknowledge_message(message_id, self.users['alice'], True))
        self.assertEqual(self.client.get('/api/conversations', headers=self.headers('alice')).json()[0]['unread_count'], 1)



    def image_bytes(self, format="PNG"):
        stream = BytesIO()
        Image.new("RGB", (8, 6), "coral").save(stream, format=format)
        return stream.getvalue()

    def test_images_formats_metadata_auth_persistence_and_deletion(self):
        images = []
        with self.client.websocket_connect('/ws') as alice, self.client.websocket_connect('/ws') as bob:
            self.authenticate(alice, 'alice')
            self.authenticate(bob, 'bob')
            for format, mime, caption in (("JPEG", "image/jpeg", "  Vacation  "), ("PNG", "image/png", ""), ("WEBP", "image/webp", "")):
                data = self.image_bytes(format)
                response = self.client.post(self.path + '/image', headers=self.headers('alice'), files={'file': ('../../malicious.exe', data, 'application/octet-stream')}, data={'caption': caption})
                self.assertEqual(response.status_code, 201)
                saved = response.json()
                images.append(saved)
                self.assertEqual(saved['content'], caption.strip())
                self.assertEqual(set(saved['attachment']), {'id', 'kind', 'mime_type', 'size_bytes', 'width', 'height'})
                self.assertEqual(saved['attachment']['mime_type'], mime)
                self.assertEqual(saved['attachment']['width'], 8)
                self.assertEqual(saved['attachment']['height'], 6)
                for socket in (alice, bob):
                    self.assertEqual(self.receive_type(socket, 'message:new'), {'type': 'message:new', 'data': saved})
                with SessionLocal() as db:
                    attachment = db.get(MessageAttachment, saved['attachment']['id'])
                    self.assertRegex(attachment.storage_name, r'^[a-f0-9]{32}\.(jpg|png|webp)$')
                    self.assertEqual(image_path(attachment.storage_name).read_bytes(), data)
                    self.assertEqual(db.scalar(select(MessageReceipt.recipient_id).where(MessageReceipt.message_id == saved['id'])), self.users['bob'])
                    if not caption:
                        self.assertEqual(db.get(Message, saved['id']).content, IMAGE_MESSAGE_SENTINEL)
                download = f"/api/attachments/{saved['attachment']['id']}/content"
                self.assertEqual(self.client.get(download).status_code, 401)
                self.assertEqual(self.client.get(download, headers=self.headers('charlie')).status_code, 404)
                for name in ('alice', 'bob'):
                    fetched = self.client.get(download, headers=self.headers(name))
                    self.assertEqual(fetched.status_code, 200)
                    self.assertEqual(fetched.content, data)
                    self.assertEqual(fetched.headers['content-type'], mime)
                    self.assertEqual(fetched.headers['x-content-type-options'], 'nosniff')
        self.assertEqual(self.client.patch(f"/api/messages/{images[0]['id']}", headers=self.headers('alice'), json={'content': 'unsupported caption edit'}).status_code, 400)
        engine.dispose()
        history = self.client.get(self.path, headers=self.headers('bob')).json()
        self.assertEqual(history, images)
        self.assertEqual(self.client.get('/api/conversations', headers=self.headers('bob')).json()[0]['unread_count'], 3)
        saved = images[1]
        with SessionLocal() as db:
            path = image_path(db.get(MessageAttachment, saved['attachment']['id']).storage_name)
        self.assertEqual(self.client.delete(f"/api/messages/{saved['id']}", headers=self.headers('alice')).status_code, 204)
        self.assertFalse(path.exists())
        with SessionLocal() as db:
            self.assertIsNone(db.get(Message, saved['id']))
            self.assertIsNone(db.get(MessageAttachment, saved['attachment']['id']))
            self.assertIsNone(db.scalar(select(MessageReceipt).where(MessageReceipt.message_id == saved['id'])))
        self.assertEqual(self.client.get('/api/conversations', headers=self.headers('bob')).json()[0]['unread_count'], 2)
        self.assertEqual(self.client.get(f"/api/attachments/{saved['attachment']['id']}/content", headers=self.headers('alice')).status_code, 404)
        old = images[-1]
        self.client.delete(f"/api/messages/{old['id']}", headers=self.headers('alice'))
        new = self.client.post(self.path + '/image', headers=self.headers('alice'), files={'file': ('new.png', self.image_bytes(), 'image/png')}).json()
        self.assertGreater(new['attachment']['id'], old['attachment']['id'])
        self.assertEqual(self.client.get(f"/api/attachments/{old['attachment']['id']}/content", headers=self.headers('alice')).status_code, 404)

    def test_image_rejection_limits_and_no_orphans(self):
        endpoint = self.path + '/image'
        valid = self.image_bytes()
        for headers, expected in (({}, 401), (self.headers('charlie'), 404)):
            with patch('app.api.attachments.store_image') as store:
                response = self.client.post(endpoint, headers=headers, files={'file': ('fake.jpg', b'not an image', 'image/jpeg')})
                self.assertEqual(response.status_code, expected)
                store.assert_not_called()
        header = struct.pack('>IIBBBBB', 100000, 100000, 8, 2, 0, 0, 0)
        bomb = valid[:8] + struct.pack('>I', 13) + b'IHDR' + header + struct.pack('>I', zlib.crc32(b'IHDR' + header)) + valid[33:]
        for data in (b'fake JPEG', b'<svg xmlns="http://www.w3.org/2000/svg"/>', self.image_bytes('GIF'), bomb, valid[:30]):
            response = self.client.post(endpoint, headers=self.headers('alice'), files={'file': ('fake.jpg', data, 'image/jpeg')})
            self.assertEqual(response.status_code, 422)
        response = self.client.post(endpoint, headers=self.headers('alice'), files={'file': ('large.png', valid + b'x' * MAX_IMAGE_BYTES, 'image/png')})
        self.assertEqual(response.status_code, 413)
        # Chunked bodies without Content-Length are bounded before spooling.
        boundary = 'smooth-test-boundary'
        prefix = f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="large.png"\r\nContent-Type: image/png\r\n\r\n'.encode()
        def chunks():
            yield prefix
            for _ in range(130):
                yield b'x' * (64 * 1024)
            yield f'\r\n--{boundary}--\r\n'.encode()
        response = self.client.post(endpoint, headers={**self.headers('alice'), 'Content-Type': f'multipart/form-data; boundary={boundary}'}, content=chunks())
        self.assertEqual(response.status_code, 413)
        self.assertEqual(self.client.post(endpoint, headers=self.headers('alice'), files={'file': ('ok.png', valid, 'image/png')}, data={'caption': 'x' * 2001}).status_code, 422)
        from app.core.config import UPLOAD_DIR
        before = set((UPLOAD_DIR / 'images').glob('*'))
        with patch('app.api.attachments.manager.broadcast') as broadcast, patch('sqlalchemy.orm.Session.commit', side_effect=RuntimeError('commit failed')):
            with self.assertRaisesRegex(RuntimeError, 'commit failed'):
                self.client.post(endpoint, headers=self.headers('alice'), files={'file': ('ok.png', valid, 'image/png')})
            broadcast.assert_not_called()
        self.assertEqual(set((UPLOAD_DIR / 'images').glob('*')), before)
        with SessionLocal() as db:
            self.assertEqual(db.scalar(select(func.count(Message.id))), 0)
            self.assertEqual(db.scalar(select(func.count(MessageAttachment.id))), 0)
            self.assertEqual(db.scalar(select(func.count(MessageReceipt.id))), 0)

    def test_attachment_paths_cannot_read_or_delete_arbitrary_files(self):
        saved = self.client.post(self.path + '/image', headers=self.headers('alice'), files={'file': ('../../attack.php', self.image_bytes(), 'text/plain')}).json()
        from app.core.config import UPLOAD_DIR
        protected = UPLOAD_DIR / 'protected.txt'
        protected.write_text('private')
        with SessionLocal() as db:
            attachment = db.get(MessageAttachment, saved['attachment']['id'])
            attachment.storage_name = '../protected.txt'
            db.commit()
        fetched = self.client.get(f"/api/attachments/{saved['attachment']['id']}/content", headers=self.headers('alice'))
        self.assertEqual(fetched.status_code, 404)
        self.assertNotIn('protected', fetched.text)
        self.assertEqual(self.client.delete(f"/api/messages/{saved['id']}", headers=self.headers('alice')).status_code, 204)
        self.assertEqual(protected.read_text(), 'private')



    def test_image_filename_collision_preserves_existing_file(self):
        from types import SimpleNamespace
        data = self.image_bytes()
        with patch('app.services.images.uuid4', return_value=SimpleNamespace(hex='a' * 32)):
            first = self.client.post(self.path + '/image', headers=self.headers('alice'), files={'file': ('ok.png', data, 'image/png')}).json()
            second = self.client.post(self.path + '/image', headers=self.headers('alice'), files={'file': ('other.png', data, 'image/png')})
            self.assertEqual(second.status_code, 503)
        fetched = self.client.get(f"/api/attachments/{first['attachment']['id']}/content", headers=self.headers('bob'))
        self.assertEqual(fetched.content, data)
        self.client.delete(f"/api/messages/{first['id']}", headers=self.headers('alice'))


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
