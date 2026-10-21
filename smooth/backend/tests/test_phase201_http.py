"""Phase 20.1 security regressions through the real API and shared SQLite state."""
import base64
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

import test_phase8 as baseline  # isolates database and uploads before app imports
from captcha_support import captcha, protected_post
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.database.database import Base, engine
from app.main import app
from app.services import antibot
from app.core.config import UPLOAD_DIR


class Phase201HTTPTests(unittest.TestCase):
    def setUp(self):
        Base.metadata.drop_all(engine)
        self.client = TestClient(app)
        self.client.__enter__()
        self.addCleanup(self.client.__exit__, None, None, None)

    def account(self, name='qa_alice'):
        body = {'username': name, 'password': 'password123'}
        registered = protected_post(self.client, '/api/auth/register', body)
        self.assertEqual(registered.status_code, 201, registered.text)
        logged = protected_post(self.client, '/api/auth/login', body)
        self.assertEqual(logged.status_code, 200, logged.text)
        return registered.json(), {'Authorization': 'Bearer ' + logged.json()['access_token']}

    def test_invalid_signed_and_unsolved_challenges_reject_both_endpoints_before_password_work(self):
        for purpose in ('register', 'login'):
            for defect in ('signature', 'solution', 'purpose', 'malformed'):
                with self.subTest(purpose=purpose, defect=defect):
                    # Each case uses a different account to isolate progressive backoff.
                    payload = captcha(self.client, purpose)
                    data = json.loads(base64.b64decode(payload))
                    if defect == 'signature':
                        data['challenge']['signature'] = '0' * 64
                    elif defect == 'solution':
                        data['solution']['derivedKey'] = 'f' * 64
                    elif defect == 'purpose':
                        data['challenge']['parameters']['data']['purpose'] = 'login' if purpose == 'register' else 'register'
                    payload = '!' if defect == 'malformed' else base64.b64encode(json.dumps(data).encode()).decode()
                    with patch('app.api.auth.hash_password') as hashing, patch('app.api.auth.verify_password') as verify:
                        response = self.client.post('/api/auth/' + purpose, json={
                            'username': 'qa_' + purpose + '_' + defect, 'password': 'password123', 'altcha': payload})
                    self.assertEqual(response.status_code, 400)
                    hashing.assert_not_called()
                    verify.assert_not_called()

    def test_expired_challenges_reject_both_endpoints(self):
        for purpose in ('register', 'login'):
            payload = captcha(self.client, purpose)
            with engine.begin() as connection:
                connection.execute(text('UPDATE auth_challenges SET expires_at=1'))
            response = self.client.post('/api/auth/' + purpose, json={
                'username': 'qa_expiry', 'password': 'password123', 'altcha': payload})
            self.assertEqual(response.status_code, 400)

    def test_registration_replay_is_rejected_before_account_conflict(self):
        body = {'username': 'qa_replay', 'password': 'password123', 'altcha': captcha(self.client, 'register')}
        self.assertEqual(self.client.post('/api/auth/register', json=body).status_code, 201)
        self.assertEqual(self.client.post('/api/auth/register', json=body).status_code, 400)

    def test_concurrent_registration_accepts_only_one_use(self):
        body = {'username': 'qa_concurrent', 'password': 'password123', 'altcha': captcha(self.client, 'register')}
        with ThreadPoolExecutor(max_workers=4) as pool:
            statuses = list(pool.map(lambda _: self.client.post('/api/auth/register', json=body).status_code, range(4)))
        self.assertEqual(sorted(statuses), [201, 400, 400, 400])

    def test_separate_processes_cannot_reuse_a_challenge(self):
        payload = captcha(self.client, 'login')
        code = '''import os
from fastapi import HTTPException
from app.services.antibot import consume
try:
 consume(os.environ['QA_CHALLENGE'], 'login')
 print(200)
except HTTPException as error:
 print(error.status_code)
'''
        environment = {**os.environ, 'QA_CHALLENGE': payload, 'PYTHONDONTWRITEBYTECODE': '1'}
        def consume(_):
            result = subprocess.run([sys.executable, '-c', code], env=environment,
                                    cwd=Path(__file__).resolve().parents[1], capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            return int(result.stdout.strip())
        with ThreadPoolExecutor(max_workers=4) as pool:
            statuses = list(pool.map(consume, range(4)))
        self.assertEqual(sorted(statuses), [200, 400, 400, 400])

    def test_rotating_proxy_headers_cannot_reset_the_api_ip_quota(self):
        for index in range(30):
            response = self.client.get('/api/auth/challenge?purpose=login', headers={
                'X-Forwarded-For': '192.0.2.' + str(index), 'X-Real-IP': '198.51.100.' + str(index),
                'Forwarded': 'for=203.0.113.' + str(index)})
            self.assertEqual(response.status_code, 200)
        response = self.client.get('/api/auth/challenge?purpose=login', headers={'X-Forwarded-For': '8.8.8.8'})
        self.assertEqual(response.status_code, 429)
        self.assertGreater(int(response.headers['Retry-After']), 0)

    def test_http_password_work_is_bounded_and_user_recovers_with_fresh_captcha(self):
        self.account()
        body = {'username': 'qa_alice', 'password': 'password123', 'altcha': captcha(self.client, 'login')}
        with antibot.password_work(), antibot.password_work(), patch('app.api.auth.verify_password') as verify:
            response = self.client.post('/api/auth/login', json=body)
            self.assertEqual(response.status_code, 503)
            self.assertEqual(response.headers['Retry-After'], '3')
            verify.assert_not_called()
        self.assertEqual(self.client.post('/api/auth/login', json=body).status_code, 400)
        body['altcha'] = captcha(self.client, 'login')
        self.assertEqual(self.client.post('/api/auth/login', json=body).status_code, 200)

    def test_backoff_expiry_and_success_recovery_through_http(self):
        self.account()
        for _ in range(3):
            response = protected_post(self.client, '/api/auth/login', {'username': 'qa_alice', 'password': 'wrong'})
            self.assertEqual(response.status_code, 401)
        with engine.connect() as connection:
            until = connection.scalar(text('SELECT max(blocked_until) FROM auth_rate_buckets'))
        self.assertGreater(until, 0)
        # Solving another real proof can take longer than the initial one-second
        # backoff. Assert the API boundary at a defined instant before expiry,
        # using an unsolved payload: quota enforcement precedes proof/KDF work.
        with patch('app.services.antibot.time.time', return_value=until - .25):
            response = self.client.post('/api/auth/login', json={
                'username': 'qa_alice', 'password': 'password123', 'altcha': 'not-solved'})
            self.assertEqual(response.status_code, 429)
            self.assertGreater(int(response.headers['Retry-After']), 0)
        # Advance only persisted deadlines; no wall-clock sleeps or auth bypass.
        with engine.begin() as connection:
            connection.execute(text('UPDATE auth_rate_buckets SET blocked_until=0'))
        self.assertEqual(protected_post(self.client, '/api/auth/login', {
            'username': 'qa_alice', 'password': 'password123'}).status_code, 200)
        with engine.connect() as connection:
            self.assertEqual(connection.scalar(text('SELECT count(*) FROM auth_rate_buckets WHERE blocked_until>0')), 0)

    def test_profile_permissions_gallery_fallback_and_exact_public_contract(self):
        alice, owner = self.account()
        _, peer = self.account('qa_bob')
        ids = []
        for _ in range(2):
            image = baseline.Phase8Tests.image_bytes(self)
            response = self.client.post('/api/profiles/me/photos', headers=owner, files={'file': ('photo.png', image, 'image/png')})
            self.assertEqual(response.status_code, 201)
            ids.append(response.json()['photos'][-1]['id'])
        self.assertEqual(len(set(ids)), 2)  # repeated content has distinct immutable photo IDs
        for method, path in (('PATCH', f'/api/profiles/me/photos/{ids[0]}/primary'),
                             ('DELETE', f'/api/profiles/me/photos/{ids[0]}')):
            self.assertEqual(self.client.request(method, path).status_code, 401)
            self.assertEqual(self.client.request(method, path, headers=peer).status_code, 404)
        public = self.client.get(f'/api/profiles/{alice["id"]}', headers=peer).json()
        self.assertEqual(set(public), {'id', 'username', 'created_at', 'primary_photo_id', 'profile_version', 'biography', 'photos', 'max_photos'})
        self.assertEqual(set(public['photos'][0]), {'id', 'position', 'width', 'height', 'size_bytes', 'created_at'})
        for photo_id in ids:
            path = f'/api/profiles/photos/{photo_id}/content'
            self.assertEqual(self.client.get(path).status_code, 401)
            self.assertEqual(self.client.get(path + '?token=not-a-bearer').status_code, 401)
            response = self.client.get(path, headers=peer)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.headers['cache-control'], 'private, no-store')
        selected = self.client.patch(f'/api/profiles/me/photos/{ids[1]}/primary', headers=owner)
        self.assertEqual(selected.json()['primary_photo_id'], ids[1])
        deleted = self.client.delete(f'/api/profiles/me/photos/{ids[1]}', headers=owner)
        self.assertEqual(deleted.json()['primary_photo_id'], ids[0])
        self.assertEqual(self.client.get(f'/api/profiles/photos/{ids[1]}/content', headers=owner).status_code, 404)
        self.assertEqual(self.client.delete(f'/api/profiles/me/photos/{ids[0]}', headers=owner).json()['primary_photo_id'], None)
        self.assertEqual(list((UPLOAD_DIR / 'profiles').glob('*')), [])

    def test_unicode_boundary_is_enforced_by_the_api_and_other_users_see_saved_bio(self):
        alice, owner = self.account()
        _, peer = self.account('qa_bob')
        value = '😀' * 1000
        response = self.client.patch('/api/profiles/me', headers=owner, json={'biography': value})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['biography'], value)
        for invalid in (value + '😀', '\x00', '\ud800'):
            response = self.client.patch('/api/profiles/me', headers={**owner, 'Content-Type': 'application/json'},
                                         content=json.dumps({'biography': invalid}))
            self.assertEqual(response.status_code, 422)
        public = self.client.get(f'/api/profiles/{alice["id"]}', headers=peer)
        self.assertEqual(public.json()['biography'], value)

    def test_simultaneous_bio_primary_and_deletion_preserve_database_and_files(self):
        user, headers = self.account()
        for _ in range(3):
            image = baseline.Phase8Tests.image_bytes(self)
            response = self.client.post('/api/profiles/me/photos', headers=headers,
                                        files={'file': ('photo.png', image, 'image/png')})
            self.assertEqual(response.status_code, 201)
        ids = [photo['id'] for photo in response.json()['photos']]
        operations = [('PATCH', '/api/profiles/me', {'biography': 'سلام 😀'}),
                      ('PATCH', f'/api/profiles/me/photos/{ids[1]}/primary', None),
                      ('DELETE', f'/api/profiles/me/photos/{ids[0]}', None),
                      ('DELETE', f'/api/profiles/me/photos/{ids[1]}', None)]
        def mutate(operation):
            method, path, body = operation
            return self.client.request(method, path, headers=headers, json=body).status_code
        with ThreadPoolExecutor(max_workers=4) as pool:
            statuses = list(pool.map(mutate, operations))
        self.assertEqual(statuses[0], 200)
        self.assertIn(statuses[1], (200, 404))  # choosing an already removed photo is rejected
        self.assertEqual(statuses[2:], [200, 200])
        result = self.client.get('/api/profiles/me', headers=headers).json()
        self.assertEqual(result['primary_photo_id'], ids[2])
        self.assertEqual(result['biography'], 'سلام 😀')
        self.assertEqual([photo['id'] for photo in result['photos']], [ids[2]])
        with engine.connect() as connection:
            self.assertEqual(connection.exec_driver_sql('PRAGMA foreign_key_check').all(), [])
            names = set(connection.execute(text('SELECT storage_name FROM user_profile_photos WHERE user_id=:id'), {'id': user['id']}).scalars())
            self.assertEqual(connection.scalar(text('SELECT count(*) FROM profile_file_gc')), 0)
        self.assertEqual({path.name for path in (UPLOAD_DIR / 'profiles').glob('*.webp')}, names)


if __name__ == '__main__':
    unittest.main()
