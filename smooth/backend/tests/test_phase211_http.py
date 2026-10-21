"""Actual authenticated multipart + DB + storage + WebSocket integration."""
import unittest
from io import BytesIO
from uuid import uuid4
from time import time
import jwt
from PIL import Image
from sqlalchemy import select, func
import test_phase8 as baseline
from app.core.config import SECRET_KEY
from app.database.database import SessionLocal, engine
from app.models.message import Message
from app.models.message_attachment import MessageAttachment
from app.models.conversation_event import ConversationEvent


class Phase211HTTPTests(unittest.TestCase):
    setUp = baseline.Phase8Tests.setUp
    headers = baseline.Phase8Tests.headers
    authenticate = baseline.Phase8Tests.authenticate
    receive_type = baseline.Phase8Tests.receive_type

    def image(self, format='JPEG', metadata=False):
        data = BytesIO()
        exif = Image.Exif()
        if metadata:
            exif[274] = 6
            exif[270] = 'synthetic QA metadata'
        Image.new('RGB', (360, 640), 'coral').save(data, format, **({'exif': exif} if metadata else {}))
        return data.getvalue()

    def upload(self, data, key, mime='image/jpeg', headers=None):
        return self.client.post(self.path + '/image', headers=headers if headers is not None else self.headers('alice'),
            files={'file': ('Gallery.jpg', data, mime)}, data={'client_message_id': key, 'caption': ''})

    def test_real_multipart_every_format_recipient_history_retrieval_and_restart(self):
        for format, mime in [('JPEG', 'image/jpeg'), ('PNG', 'image/png'), ('WEBP', 'image/webp')]:
            with self.subTest(format=format):
                key = str(uuid4())
                with self.client.websocket_connect('/ws') as socket:
                    self.authenticate(socket, 'bob')
                    uploaded = self.upload(self.image(format), key, mime)
                    self.assertEqual(uploaded.status_code, 201)
                    self.assertIn('multipart/form-data; boundary=', uploaded.request.headers['content-type'])
                    message = uploaded.json()
                    self.assertEqual(self.receive_type(socket, 'message:new')['data']['id'], message['id'])
                # Simulates retry after the first successful response was lost.
                self.assertEqual(self.upload(self.image(format), key, mime).json()['id'], message['id'])
                engine.dispose()
                history = self.client.get(self.path, headers=self.headers('bob')).json()
                self.assertIn(message['id'], [item['id'] for item in history])
                path = f"/api/attachments/{message['attachment']['id']}/content"
                self.assertEqual(self.client.get(path).status_code, 401)
                self.assertEqual(self.client.get(path, headers=self.headers('charlie')).status_code, 404)
                for actor in ['alice', 'bob']:
                    download = self.client.get(path, headers=self.headers(actor))
                    self.assertEqual(download.status_code, 200)
                    self.assertEqual(download.headers['content-type'], mime)
                    with Image.open(BytesIO(download.content)) as decoded:
                        decoded.load()
                        self.assertEqual(decoded.size, (360, 640))
                with SessionLocal() as db:
                    self.assertEqual(db.scalar(select(func.count()).select_from(Message).where(Message.client_message_id == key)), 1)
                    self.assertEqual(db.scalar(select(func.count()).select_from(ConversationEvent).where(ConversationEvent.message_id == message['id'], ConversationEvent.kind == 'new')), 1)

    def test_expired_auth_and_malformed_boundary_do_not_publish(self):
        expired = jwt.encode({'sub':str(self.users['alice']), 'username':'alice', 'iat':int(time())-100, 'exp':int(time())-1}, SECRET_KEY, algorithm='HS256')
        for token in [expired, 'invalid']:
            self.assertEqual(self.upload(self.image(),str(uuid4()),headers={'Authorization':'Bearer '+token}).status_code,401)
        response = self.client.post(self.path + '/image', headers={**self.headers('alice'), 'Content-Type':'multipart/form-data'}, content=b'invalid')
        self.assertEqual(response.status_code,400)
        with SessionLocal() as db:
            self.assertEqual(db.scalar(select(func.count()).select_from(MessageAttachment)),0)
            self.assertEqual(db.scalar(select(func.count()).select_from(Message)),0)

    def test_oriented_metadata_free_photo_is_retrieved_by_authorized_recipient(self):
        result = self.upload(self.image(metadata=True),str(uuid4()))
        self.assertEqual(result.status_code,201)
        attachment = result.json()['attachment']
        self.assertEqual((attachment['width'],attachment['height']),(640,360))
        response = self.client.get(f"/api/attachments/{attachment['id']}/content",headers=self.headers('bob'))
        with Image.open(BytesIO(response.content)) as decoded:
            decoded.load()
            self.assertFalse(decoded.getexif())
            self.assertEqual(decoded.size,(640,360))
