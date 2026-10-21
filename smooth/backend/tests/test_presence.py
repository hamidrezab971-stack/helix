"""Last-seen persistence, privacy and adversarial reconnect ordering."""
import asyncio
from datetime import UTC, datetime, timedelta
from time import time
import unittest
from unittest.mock import AsyncMock, patch

import test_phase8 as baseline
from app.database.database import SessionLocal
from app.models.user import User
from app.realtime.manager import ConnectionManager
from app.services.presence import persist_seen


class PresenceContractTests(unittest.TestCase):
    setUp = baseline.Phase8Tests.setUp
    headers = baseline.Phase8Tests.headers
    receive_type = baseline.Phase8Tests.receive_type

    def test_missing_timestamp_is_null_for_member_and_hidden_from_directory(self):
        response = self.client.get('/api/users/presence', headers=self.headers('alice'))
        self.assertEqual(response.json()['users'], [{'user_id': self.users['bob'], 'online': False, 'last_seen_at': None}])
        self.assertEqual(self.client.get('/api/users/presence', headers=self.headers('charlie')).json()['users'], [])
        self.assertTrue(all('last_seen_at' not in row for row in self.client.get('/api/users', headers=self.headers('charlie')).json()))
        self.assertEqual(self.client.get('/api/users/presence').status_code, 401)

    def test_final_disconnect_persists_exact_event_timestamp_for_refresh_and_reconnect(self):
        with self.client.websocket_connect('/ws') as alice:
            alice.send_json({'type': 'auth', 'token': self.tokens['alice'], 'presence_version': 204})
            self.assertEqual(alice.receive_json()['type'], 'auth:ok')
            snapshot = self.receive_type(alice, 'presence:snapshot')['data']
            self.assertIn('revision', snapshot)
            with self.client.websocket_connect('/ws') as bob:
                baseline.Phase8Tests.authenticate(self, bob, 'bob')
                online = self.receive_type(alice, 'presence:update')['data']
                self.assertEqual(online['status'], 'online')
                self.assertGreater(online['revision'], snapshot['revision'])
            offline = self.receive_type(alice, 'presence:update')['data']
            self.assertGreater(offline['revision'], online['revision'])
            self.assertEqual(offline['status'], 'offline')
            self.assertLessEqual(datetime.fromisoformat(offline['last_seen_at']), datetime.fromisoformat(offline['server_time']))
            for _ in range(2):
                details = self.client.get('/api/users/presence', headers=self.headers('alice')).json()['users'][0]
                self.assertEqual(details['last_seen_at'], offline['last_seen_at'])
                self.assertFalse(details['online'])
            with self.client.websocket_connect('/ws') as bob:
                baseline.Phase8Tests.authenticate(self, bob, 'bob')
                newer = self.receive_type(alice, 'presence:update')['data']
                self.assertEqual(newer['status'], 'online')
                self.assertGreater(newer['revision'], offline['revision'])

    def test_older_activity_write_cannot_overwrite_newer_persisted_seen(self):
        newer = datetime.now(UTC).replace(tzinfo=None)
        with SessionLocal() as db:
            db.get(User, self.users['bob']).last_seen_at = newer
            db.commit()
        with patch('app.services.presence.datetime') as clock:
            clock.now.return_value = (newer - timedelta(seconds=10)).replace(tzinfo=UTC)
            stamp = persist_seen(self.users['bob'])
        self.assertEqual(datetime.fromisoformat(stamp).replace(tzinfo=None), newer)
        with SessionLocal() as db:
            self.assertEqual(db.get(User, self.users['bob']).last_seen_at, newer)

    def test_ordered_protocol_keeps_last_seen_private_to_conversation_members(self):
        with self.client.websocket_connect('/ws') as alice, self.client.websocket_connect('/ws') as charlie:
            for socket, name in ((alice, 'alice'), (charlie, 'charlie')):
                socket.send_json({'type': 'auth', 'token': self.tokens[name], 'presence_version': 204})
                self.assertEqual(socket.receive_json()['type'], 'auth:ok')
                self.receive_type(socket, 'presence:snapshot')
            self.receive_type(alice, 'presence:update')
            with self.client.websocket_connect('/ws') as bob:
                baseline.Phase8Tests.authenticate(self, bob, 'bob')
                self.receive_type(alice, 'presence:update')
                self.receive_type(charlie, 'presence:update')
            trusted = self.receive_type(alice, 'presence:update')['data']
            unapproved = self.receive_type(charlie, 'presence:update')['data']
            self.assertIsNotNone(trusted['last_seen_at'])
            self.assertEqual(set(unapproved), {'user_id', 'status', 'revision', 'server_time'})
            self.assertEqual(unapproved['user_id'], self.users['bob'])
            self.assertEqual(unapproved['status'], 'offline')
            self.assertEqual(unapproved['revision'], trusted['revision'])


class PresenceOrderingTests(unittest.IsolatedAsyncioTestCase):
    async def test_reconnect_during_final_persistence_does_not_emit_stale_offline(self):
        manager = ConnectionManager()
        entered, release = asyncio.Event(), asyncio.Event()

        async def touch(user_id, final=False):
            if user_id == 2 and final:
                entered.set()
                await release.wait()
            return None

        manager.touch = touch
        observer = AsyncMock()
        await manager.register(1, observer, time() + 100, detailed_presence=True, ordered_presence=True)
        old = await manager.register(2, AsyncMock(), time() + 100)
        task = asyncio.create_task(manager.disconnect(old))
        await asyncio.wait_for(entered.wait(), 2)
        await manager.register(2, AsyncMock(), time() + 100)
        release.set()
        await task
        events = [call.args[0]['data'] for call in observer.send_json.call_args_list if call.args[0]['type'] == 'presence:update' and call.args[0]['data']['user_id'] == 2]
        self.assertEqual([event['status'] for event in events], ['online', 'online'])
        self.assertLess(events[0]['revision'], events[1]['revision'])
        self.assertIn(2, manager.online_user_ids())

    async def test_reconnect_during_membership_lookup_does_not_deliver_old_offline(self):
        manager = ConnectionManager(durable=True)
        entered, release = asyncio.Event(), asyncio.Event()

        async def worker(function, *args):
            if function.__name__ == 'presence_recipients':
                entered.set()
                await release.wait()
                return [1]
            return datetime.now(UTC).isoformat()

        with patch('app.realtime.manager.run_in_threadpool', side_effect=worker):
            observer = AsyncMock()
            await manager.register(1, observer, time() + 100, detailed_presence=True, ordered_presence=True)
            old = await manager.register(2, AsyncMock(), time() + 100)
            task = asyncio.create_task(manager.disconnect(old))
            await asyncio.wait_for(entered.wait(), 2)
            await manager.register(2, AsyncMock(), time() + 100)
            release.set()
            await task
        events = [call.args[0]['data'] for call in observer.send_json.call_args_list if call.args[0]['type'] == 'presence:update' and call.args[0]['data']['user_id'] == 2]
        self.assertEqual([event['status'] for event in events], ['online', 'online'])

    async def test_disconnected_registration_cannot_later_broadcast_stale_online(self):
        manager = ConnectionManager()
        entered, release = asyncio.Event(), asyncio.Event()

        async def touch(user_id, final=False):
            if user_id == 2 and not final:
                entered.set()
                await release.wait()

        manager.touch = touch
        observer = AsyncMock()
        await manager.register(1, observer, time() + 100, detailed_presence=True, ordered_presence=True)
        task = asyncio.create_task(manager.register(2, AsyncMock(), time() + 100))
        await asyncio.wait_for(entered.wait(), 2)
        await manager.disconnect(next(iter(manager.connections[2])))
        release.set()
        await task
        events = [call.args[0]['data'] for call in observer.send_json.call_args_list if call.args[0]['type'] == 'presence:update' and call.args[0]['data']['user_id'] == 2]
        self.assertEqual([event['status'] for event in events], ['offline'])
        self.assertNotIn(2, manager.online_user_ids())
