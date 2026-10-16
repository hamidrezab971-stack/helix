"""Phase 18 additive send identity and presence regressions."""
import unittest
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4
from unittest.mock import patch
from pathlib import Path
import test_phase8 as baseline
from sqlalchemy import select, func, inspect, text, create_engine
from app.database.database import SessionLocal, engine
from app.database.migrations import migrate_phase18
from app.models.message import Message, MessageSendIntent
from app.models.message_attachment import MessageAttachment
from app.models.conversation_event import ConversationEvent
from app.core.config import UPLOAD_DIR

class Phase18Tests(unittest.TestCase):
    setUp = baseline.Phase8Tests.setUp
    headers = baseline.Phase8Tests.headers
    image_bytes = baseline.Phase8Tests.image_bytes

    def send(self, key, content='Original', **extra):
        return self.client.post(self.path, headers=self.headers('alice'), json={'content': content, 'client_message_id': key, **extra})

    def image(self, key, caption='', data=None):
        return self.client.post(self.path + '/image', headers=self.headers('alice'), files={'file': ('photo.png', data or self.image_bytes(), 'image/png')}, data={'caption': caption, 'client_message_id': key})

    def test_identity_replay_conflict_edits_deletion_and_restart(self):
        key = str(uuid4())
        original = self.send(key)
        self.assertEqual(original.status_code, 201, original.text)
        self.assertEqual(original.json()['client_message_id'], key)
        self.assertEqual(self.send(key).json()['id'], original.json()['id'])
        self.assertEqual(self.send(key, 'Different').status_code, 409)
        self.client.patch('/api/messages/' + str(original.json()['id']), headers=self.headers('alice'), json={'content': 'Edited'})
        engine.dispose()
        self.assertEqual(self.send(key).json()['content'], 'Edited')
        self.client.delete('/api/messages/' + str(original.json()['id']), headers=self.headers('alice'))
        self.assertEqual(self.send(key).status_code, 410)
        with SessionLocal() as db:
            self.assertEqual(db.scalar(select(func.count()).select_from(Message)), 0)
            self.assertEqual(db.scalar(select(func.count()).select_from(MessageSendIntent)), 1)
            self.assertEqual(db.scalar(select(func.count()).select_from(ConversationEvent).where(ConversationEvent.kind == 'new')), 1)

    def test_concurrent_duplicate_and_sender_scope(self):
        key = str(uuid4())
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: self.send(key), range(4)))
        self.assertTrue(all(result.status_code == 201 for result in results), [r.text for r in results])
        self.assertEqual(len({result.json()['id'] for result in results}), 1)
        other = self.client.post(self.path, headers=self.headers('bob'), json={'content': 'Original', 'client_message_id': key})
        self.assertEqual(other.status_code, 201)
        self.assertNotEqual(other.json()['id'], results[0].json()['id'])
        self.assertEqual(self.send('invalid').status_code, 422)
        forbidden = self.client.post(self.path, headers=self.headers('charlie'), json={'content':'Original', 'client_message_id':key})
        self.assertEqual(forbidden.status_code, 404)

    def test_image_retries_cleanup_and_payload_conflicts(self):
        key = str(uuid4())
        with ThreadPoolExecutor(max_workers=3) as pool:
            results = list(pool.map(lambda _: self.image(key), range(3)))
        self.assertTrue(all(result.status_code == 201 for result in results), [r.text for r in results])
        self.assertEqual(len({r.json()['id'] for r in results}), 1)
        self.assertEqual(len(list((UPLOAD_DIR / 'images').glob('*'))), 1)
        self.assertEqual(self.image(key, 'Other caption').status_code, 409)
        self.assertEqual(self.send(key).status_code, 409)
        self.assertEqual(len(list((UPLOAD_DIR / 'images').glob('*'))), 1)
        with SessionLocal() as db:
            self.assertEqual(db.scalar(select(func.count()).select_from(MessageAttachment)), 1)
        self.client.delete('/api/messages/' + str(results[0].json()['id']), headers=self.headers('alice'))
        self.assertEqual(self.image(key).status_code, 410)
        self.assertEqual(len(list((UPLOAD_DIR / 'images').glob('*'))), 0)

    def test_failed_image_transaction_has_no_file_or_intent(self):
        # A prior test may leave files in the shared temporary upload directory.
        before = set((UPLOAD_DIR / 'images').glob('*'))
        key = str(uuid4())
        with patch('sqlalchemy.orm.Session.commit', side_effect=RuntimeError('failed')):
            with self.assertRaises(RuntimeError): self.image(key)
        self.assertEqual(set((UPLOAD_DIR / 'images').glob('*')), before)
        with SessionLocal() as db:
            self.assertIsNone(db.get(MessageSendIntent, (self.users['alice'], key)))
        self.assertEqual(self.image(key).status_code, 201)

    def test_migrate_real_legacy_schema_idempotently(self):
        legacy = create_engine('sqlite://')
        with legacy.begin() as c:
            c.execute(text('CREATE TABLE users (id INTEGER PRIMARY KEY)'))
            c.execute(text('CREATE TABLE messages (id INTEGER PRIMARY KEY, sender_id INTEGER, content TEXT)'))
            c.execute(text("INSERT INTO messages VALUES (1, 1, 'Preserved')"))
            c.execute(text('CREATE TABLE smooth_schema_migrations (version INTEGER PRIMARY KEY)'))
        migrate_phase18(legacy); migrate_phase18(legacy)
        self.assertIn('client_message_id', {col['name'] for col in inspect(legacy).get_columns('messages')})
        with legacy.connect() as c:
            self.assertEqual(c.execute(text('SELECT content, client_message_id FROM messages')).one(), ('Preserved', None))
        legacy.dispose()
