"""Run with: python -m unittest discover -s tests -v (requires httpx2)."""
import os
import tempfile
import unittest
from unittest.mock import patch

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
from sqlalchemy import func, select
from starlette.websockets import WebSocketDisconnect

from app.core.config import SECRET_KEY
from app.database.database import Base, SessionLocal, engine
from app.main import app
from app.models.message import Message
from app.models.user import User
from app.realtime.manager import manager


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

    def test_delivery_multiple_tabs_and_offline_history(self):
        with self.client.websocket_connect("/ws") as alice, self.client.websocket_connect("/ws") as bob, self.client.websocket_connect("/ws") as bob_tab:
            for socket, name in ((alice, "alice"), (bob, "bob"), (bob_tab, "bob")):
                self.authenticate(socket, name)
            for sender, content in (("alice", "hello bob"), ("bob", "hello alice")):
                response = self.client.post(self.path, headers=self.headers(sender), json={"content": content})
                self.assertEqual(response.status_code, 201)
                for socket in (alice, bob, bob_tab):
                    self.assertEqual(socket.receive_json(), {"type": "message:new", "data": response.json()})
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


if __name__ == "__main__":
    unittest.main()
