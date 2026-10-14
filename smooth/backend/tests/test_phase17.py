"""Bounded history, durable recovery, additive migration, and receipt ranges."""
import unittest
from datetime import datetime
from time import time
from unittest.mock import patch

import jwt
from sqlalchemy import event, func, inspect, select, text

import test_phase8 as baseline
from app.core.config import SECRET_KEY
from app.database.database import engine, SessionLocal
from app.database.migrations import migrate_phase17
from app.models.conversation_event import ConversationEvent, ConversationSyncState
from app.models.message import Message
from app.models.message_receipt import MessageReceipt
from app.services.sync import cursor, prune_events, TIMESTAMP_SQL


class Phase17Tests(unittest.TestCase):
    setUp = baseline.Phase8Tests.setUp
    headers = baseline.Phase8Tests.headers
    authenticate = baseline.Phase8Tests.authenticate
    receive_type = baseline.Phase8Tests.receive_type
    image_bytes = baseline.Phase8Tests.image_bytes

    @property
    def cid(self):
        return int(self.path.split('/')[3])

    @property
    def sync_path(self):
        return f'/api/conversations/{self.cid}/sync'

    def page(self, name='alice', **params):
        result = self.client.get(self.path + '/page', headers=self.headers(name), params=params)
        self.assertEqual(result.status_code, 200, result.text)
        return result.json()

    def send(self, content, name='alice', **extra):
        result = self.client.post(self.path, headers=self.headers(name), json={'content': content, **extra})
        self.assertEqual(result.status_code, 201, result.text)
        return result.json()

    def replay(self, after, ids=(), **params):
        result = self.client.post(self.sync_path, headers=self.headers('bob'), params={'after': after, **params}, json={'message_ids': list(ids)})
        self.assertEqual(result.status_code, 200, result.text)
        return result.json()

    def seed(self, count):
        # Identical timestamps intentionally stress the stable secondary key.
        with SessionLocal() as db:
            db.add_all([Message(id=i + 1, conversation_id=self.cid, sender_id=self.users['alice'], content=f'history {i + 1}', created_at=datetime(2025, 1, 1)) for i in range(count)])
            db.flush()
            db.add_all([MessageReceipt(message_id=i + 1, recipient_id=self.users['bob']) for i in range(count)])
            db.commit()

    def test_empty_one_thirty_and_thirty_one(self):
        self.assertEqual(self.page()['items'], [])
        self.assertIsNone(self.page()['next_cursor'])
        for i in range(31):
            self.send(str(i))
            if i in (0, 29, 30):
                page = self.page()
                self.assertEqual(len(page['items']), min(i + 1, 30))
                self.assertEqual(page['has_more'], i == 30)
        older = self.page(before=page['next_cursor'])
        self.assertEqual(len(older['items']), 1)
        self.assertFalse(older['has_more'])
        forward = self.page(after=older['cursors'][str(older['items'][0]['id'])])
        self.assertEqual(forward['items'], page['items'])

    def test_ten_thousand_identical_timestamps_bounded_ordered_and_indexed(self):
        self.seed(10000)
        queries = []
        def count(_conn, _cur, statement, _params, _context, _many):
            queries.append(statement)
        event.listen(engine, 'before_cursor_execute', count)
        try:
            page = self.page()
        finally:
            event.remove(engine, 'before_cursor_execute', count)
        self.assertEqual([item['id'] for item in page['items']], list(range(9971, 10001)))
        self.assertLessEqual(len(queries), 10, 'No per-message hydration queries')
        self.assertTrue(page['has_more'])
        ids = [item['id'] for item in page['items']]
        while page['has_more']:
            page = self.page(before=page['next_cursor'], limit=100)
            self.assertLessEqual(len(page['items']), 100)
            chunk = [item['id'] for item in page['items']]
            self.assertEqual(chunk, sorted(chunk))
            ids = chunk + ids
        self.assertEqual(ids, list(range(1, 10001)))
        with engine.connect() as connection:
            plan = connection.execute(text(f'EXPLAIN QUERY PLAN SELECT id FROM messages WHERE conversation_id=:c ORDER BY ({TIMESTAMP_SQL}) DESC, id DESC LIMIT 30'), {'c': self.cid}).all()
            self.assertTrue(any('ix_messages_timeline' in str(row) for row in plan))

    def test_mixed_sqlite_timestamp_formats_share_one_stable_boundary(self):
        with engine.begin() as connection:
            for message_id, stamp in [(1, '2025-01-01 00:00:00.000000'), (2, '2025-01-01 00:00:00'),
                                      (3, '2025-01-01 00:00:00.000001')]:
                connection.execute(text('INSERT INTO messages (id, conversation_id, sender_id, content, created_at) VALUES (:i, :c, :u, :content, :t)'),
                    {'i': message_id, 'c': self.cid, 'u': self.users['alice'], 'content': f'Message {message_id}', 't': stamp})
                connection.execute(text('INSERT INTO message_receipts (message_id, recipient_id) VALUES (:i, :u)'),
                    {'i': message_id, 'u': self.users['bob']})
        newest = self.page('bob', limit=1)
        self.assertEqual(newest['items'][0]['id'], 3)
        middle = self.page('bob', before=newest['next_cursor'], limit=1)
        self.assertEqual(middle['items'][0]['id'], 2)
        oldest = self.page('bob', before=middle['next_cursor'], limit=1)
        self.assertEqual(oldest['items'][0]['id'], 1)
        self.assertFalse(oldest['has_more'])
        forward = self.page('bob', after=oldest['cursors']['1'])
        self.assertEqual([item['id'] for item in forward['items']], [2, 3])
        self.client.post(f'/api/conversations/{self.cid}/receipts', headers=self.headers('bob'), json={'through': middle['read_cursor']})
        # The range is the snapshot's newest key, even on an older page.
        self.assertEqual(self.client.get('/api/conversations', headers=self.headers('bob')).json()[0]['unread_count'], 0)

    def test_cursor_validation_expiry_and_membership(self):
        self.send('Boundary')
        page = self.page()
        valid = page['cursors']['1']
        for params in ({'limit': 0}, {'limit': 101}, {'before': '' + 'x'}, {'before': valid, 'after': valid}, {'before': cursor('sync', self.cid, s=0)}):
            self.assertEqual(self.client.get(self.path + '/page', headers=self.headers('alice'), params=params).status_code, 422)
        expired = jwt.encode({'v': 17, 'kind': 'history', 'c': self.cid, 'exp': time() - 10, 't': '2025-01-01', 'i': 1}, SECRET_KEY, algorithm='HS256')
        self.assertEqual(self.client.get(self.path + '/page', headers=self.headers('alice'), params={'before': expired}).status_code, 410)
        other = self.client.post(f'/api/conversations/with/{self.users["charlie"]}', headers=self.headers('alice')).json()['id']
        self.assertEqual(self.client.get(f'/api/conversations/{other}/messages/page', headers=self.headers('alice'), params={'before': valid}).status_code, 422)
        for suffix in ('/page', '/1/context'):
            self.assertEqual(self.client.get(self.path + suffix, headers=self.headers('charlie')).status_code, 404)
            self.assertEqual(self.client.get(self.path + suffix).status_code, 401)
        self.assertEqual(self.client.post(self.sync_path, headers=self.headers('charlie'), params={'after': page['sync_cursor']}, json={}).status_code, 404)
        self.assertEqual(self.client.post(f'/api/conversations/{other}/sync', headers=self.headers('alice'), params={'after': page['sync_cursor']}, json={}).status_code, 422)

    def test_page_boundary_edits_deletions_images_replies_and_personalized_reactions(self):
        self.seed(31)
        before = self.page()['next_cursor']
        self.client.patch('/api/messages/1', headers=self.headers('alice'), json={'content': 'Edited oldest'})
        self.client.post('/api/messages/1/reactions', headers=self.headers('bob'), json={'emoji': '👍'})
        reply = self.send('Newest reply', reply_to_message_id=1)
        image = self.client.post(self.path + '/image', headers=self.headers('alice'), files={'file': ('photo.png', self.image_bytes(), 'image/png')}, data={'reply_to_message_id': '1'}).json()
        oldest = self.page('bob', before=before)['items'][0]
        self.assertEqual(oldest['content'], 'Edited oldest')
        self.assertTrue(oldest['reactions'][0]['reacted_by_me'])
        self.assertTrue(oldest['edited_at'])
        newest = self.page()['items']
        self.assertEqual(newest[-1]['attachment'], image['attachment'])
        self.assertEqual(newest[-1]['reply_to']['content'], 'Edited oldest')
        self.assertEqual(next(item for item in newest if item['id'] == reply['id'])['reply_to']['id'], 1)
        context = self.client.get(self.path + '/1/context', headers=self.headers('bob')).json()
        self.assertLessEqual(len(context['items']), 31)
        self.assertEqual(context['items'][0]['id'], 1)
        # A deleted cursor boundary still defines a valid history position.
        self.client.delete('/api/messages/2', headers=self.headers('alice'))
        self.assertEqual(self.page(before=before)['items'][0]['id'], 1)
        self.client.delete('/api/messages/1', headers=self.headers('alice'))
        self.assertEqual(self.client.get(self.path + '/1/context', headers=self.headers('bob')).status_code, 404)
        self.assertIsNone(self.page()['items'][-1]['reply_to'])

    def test_offline_recovery_replay_duplicates_restart_and_latest_state(self):
        first = self.send('Edit me'); second = self.send('Delete me')
        initial = self.page('bob')
        self.client.patch(f'/api/messages/{first["id"]}', headers=self.headers('alice'), json={'content': 'Committed offline edit'})
        self.client.delete(f'/api/messages/{second["id"]}', headers=self.headers('alice'))
        self.client.post(f'/api/messages/{first["id"]}/reactions', headers=self.headers('bob'), json={'emoji': '❤️'})
        for i in range(7): self.send(f'Missed {i}')
        engine.dispose()  # New connections use the persisted journal after restart.
        recovered = self.replay(initial['sync_cursor'], [first['id'], second['id']], limit=2)
        self.assertTrue(recovered['has_more'])
        seen = recovered['events'][:]
        all_items = {item['id']: item for item in recovered['items']}
        duplicate = self.replay(initial['sync_cursor'], [first['id'], second['id']], limit=2)
        self.assertEqual(duplicate['events'], recovered['events'])
        self.assertIn(second['id'], recovered['missing_ids'])
        while recovered['has_more']:
            recovered = self.replay(recovered['next_cursor'], all_items, limit=2)
            seen += recovered['events']
            all_items.update({item['id']: item for item in recovered['items']})
        self.assertEqual(len(seen), 10)
        self.assertEqual(len({event['id'] for event in seen}), 10)
        self.assertEqual(all_items[first['id']]['content'], 'Committed offline edit')
        self.assertTrue(all_items[first['id']]['reactions'][0]['reacted_by_me'])
        self.assertEqual(len(all_items), 8)
        self.assertEqual(self.replay(recovered['next_cursor'])['events'], [])
        # Receipt changes are durable too, including bulk ranges.
        read = self.page('bob')
        self.client.post(f'/api/conversations/{self.cid}/receipts', headers=self.headers('bob'), json={'through': read['read_cursor']})
        status = self.replay(recovered['next_cursor'], all_items)
        self.assertEqual([event['kind'] for event in status['events']], ['receipts'])
        self.assertTrue(all(item['read_at'] and item['delivered_at'] for item in status['items']))
        with SessionLocal() as db:
            self.assertTrue(all(set(row.__table__.columns.keys()) == {'id', 'conversation_id', 'kind', 'message_id'} for row in db.scalars(select(ConversationEvent))))

    def test_failed_transactions_do_not_append_or_publish(self):
        first = self.send('Original')
        before = self.page()['event_id']
        for method, path, data in [('post', self.path, {'content': 'Failed'}), ('patch', f'/api/messages/{first["id"]}', {'content': 'Failed edit'}), ('post', f'/api/messages/{first["id"]}/reactions', {'emoji': '👍'}), ('delete', f'/api/messages/{first["id"]}', None)]:
            with patch('sqlalchemy.orm.Session.commit', side_effect=RuntimeError('failed')):
                with self.assertRaises(RuntimeError):
                    getattr(self.client, method)(path, headers=self.headers('alice'), **({'json': data} if data else {}))
            self.assertEqual(self.page()['event_id'], before)
        self.assertEqual(self.page()['items'][0]['content'], 'Original')

    def test_retention_floor_explicit_gap_and_non_reused_event_ids(self):
        initial = self.page()
        self.send('A'); self.send('B')
        head = self.page()['event_id']
        with SessionLocal() as db:
            prune_events(db, self.cid, head)
            db.commit()
        gap = self.client.post(self.sync_path, headers=self.headers('bob'), params={'after': initial['sync_cursor']}, json={})
        self.assertEqual(gap.status_code, 409)
        self.assertEqual(gap.json()['detail']['code'], 'replay_gap')
        reset = self.page('bob')
        self.assertEqual(self.replay(reset['sync_cursor'])['events'], [])
        self.send('C')
        self.assertGreater(self.page()['event_id'], head)
        expired = jwt.encode({'v': 17, 'kind': 'sync', 'c': self.cid, 's': head, 'exp': time()-1}, SECRET_KEY, algorithm='HS256')
        self.assertEqual(self.client.post(self.sync_path, headers=self.headers('bob'), params={'after': expired}, json={}).status_code, 410)
        self.assertEqual(self.client.post(self.sync_path, headers=self.headers('bob'), params={'after': reset['sync_cursor']}, json={'message_ids': [1] * 301}).status_code, 422)

    def test_bulk_read_partial_history_range_isolation_and_multitab_idempotency(self):
        self.seed(1000)
        older = self.page('bob')
        later = self.send('After snapshot')
        receipt_path = f'/api/conversations/{self.cid}/receipts'
        response = self.client.post(receipt_path, headers=self.headers('bob'), json={'through': older['read_cursor']})
        self.assertEqual(response.json()['changed'], 1000)
        self.assertEqual(self.client.post(receipt_path, headers=self.headers('bob'), json={'through': older['read_cursor']}).json()['changed'], 0)
        self.assertEqual(self.client.post(receipt_path, headers=self.headers('alice'), json={'through': older['read_cursor']}).status_code, 422)
        self.assertEqual(self.client.post(receipt_path, headers=self.headers('charlie'), json={'through': older['read_cursor']}).status_code, 404)
        self.assertEqual(self.client.post(receipt_path, headers=self.headers('bob'), json={'through': older['sync_cursor']}).status_code, 422)
        unread = self.client.get('/api/conversations', headers=self.headers('bob')).json()[0]['unread_count']
        self.assertEqual(unread, 1)
        with SessionLocal() as db:
            events = list(db.scalars(select(ConversationEvent).where(ConversationEvent.kind == 'receipts')))
            self.assertEqual(len(events), 1)
            old_receipt = db.scalar(select(MessageReceipt).where(MessageReceipt.message_id == 1))
            old_time = old_receipt.read_at
            self.assertGreaterEqual(old_time, old_receipt.delivered_at)
            self.assertIsNone(db.scalar(select(MessageReceipt).where(MessageReceipt.message_id == later['id'])).read_at)
        current = self.page('bob')
        self.client.post(receipt_path, headers=self.headers('bob'), json={'through': current['read_cursor'], 'read': False})
        with SessionLocal() as db:
            self.assertIsNone(db.scalar(select(MessageReceipt).where(MessageReceipt.message_id == later['id'])).read_at)
        self.client.post(receipt_path, headers=self.headers('bob'), json={'through': current['read_cursor']})
        with SessionLocal() as db:
            self.assertEqual(db.scalar(select(MessageReceipt).where(MessageReceipt.message_id == 1)).read_at, old_time)

    def test_additive_migration_old_database_preserves_data_foreign_keys_and_index(self):
        stored = self.send('Keep this data')
        original = inspect(engine).get_columns('messages')
        with engine.begin() as connection:
            connection.execute(text('DROP TABLE conversation_events'))
            connection.execute(text('DROP TABLE conversation_sync_state'))
            connection.execute(text('DROP INDEX ix_messages_history'))
            connection.execute(text('DELETE FROM smooth_schema_migrations WHERE version=17'))
            connection.execute(text("UPDATE messages SET created_at='2025-01-01 00:00:00'"))
        migrate_phase17(engine); migrate_phase17(engine)
        self.assertEqual([str(c['type']) for c in inspect(engine).get_columns('messages')], [str(c['type']) for c in original])
        self.assertEqual(self.page()['items'][0]['content'], stored['content'])
        with engine.connect() as connection:
            indexes = [row[1] for row in connection.execute(text('PRAGMA index_list(messages)'))]
            self.assertIn('ix_messages_history', indexes)
            self.assertIn('ix_messages_timeline', indexes)
            self.assertEqual(connection.execute(text('SELECT created_at FROM messages WHERE id=:id'), {'id': stored['id']}).scalar_one(), '2025-01-01 00:00:00')
            self.assertEqual(connection.execute(text('PRAGMA foreign_keys')).scalar_one(), 1)
            self.assertEqual(connection.execute(text('PRAGMA foreign_key_check')).all(), [])
        self.assertFalse(self.page()['has_older'])
        self.send('New migrated event')
        self.assertGreater(self.page()['event_id'], 0)
