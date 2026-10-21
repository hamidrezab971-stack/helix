"""Real multipart parsing, JWT authorization, SQLite transactions and files.

This synchronous service integration supplements the HTTP/Chromium suites; it
is not a substitute for exercising their real network transports.
"""
import asyncio
import unittest
from io import BytesIO
from uuid import uuid4
from unittest.mock import patch
from fastapi import HTTPException, Response
from fastapi.security import HTTPAuthorizationCredentials
from starlette.requests import Request
from PIL import Image
from sqlalchemy import select, func
import test_phase8 as baseline
from app.database.database import Base, engine, SessionLocal
from app.models.user import User
from app.models.message import Message
from app.models.message_attachment import MessageAttachment
from app.core.auth import get_current_user
from app.core.security import create_access_token
from app.api.attachments import create_image_message, download_image
from app.api.conversations import get_or_create_conversation, get_messages


class Phase211ServiceTests(unittest.TestCase):
    def setUp(self):
        Base.metadata.drop_all(engine)
        Base.metadata.create_all(engine)
        self.db = SessionLocal()
        self.addCleanup(self.db.close)
        self.actors = []
        for name in ('service_alice', 'service_bob', 'service_other'):
            user = User(username=name, password_hash='unused-synthetic-service-test')
            self.db.add(user)
            self.db.commit()
            credentials = HTTPAuthorizationCredentials(scheme='Bearer', credentials=create_access_token(user.id, name))
            self.actors.append(get_current_user(credentials, self.db))
        self.cid = get_or_create_conversation(self.actors[1].id, Response(), self.actors[0], self.db).id

    def parse(self, format):
        data = BytesIO()
        Image.new('RGB', (180, 320), 'coral').save(data, format)
        mime = {'JPEG':'image/jpeg','PNG':'image/png','WEBP':'image/webp'}[format]
        boundary = 'helix-phase211-real-multipart'
        body = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="Gallery.jpg"\r\nContent-Type: {mime}\r\n\r\n').encode() + data.getvalue() + (f'\r\n--{boundary}--\r\n').encode()
        async def receive():
            return {'type':'http.request','body':body,'more_body':False}
        request = Request({'type':'http','method':'POST','path':'/test','headers':[(b'content-type',f'multipart/form-data; boundary={boundary}'.encode())]},receive)
        async def parse():
            return await request.form()
        return asyncio.run(parse())

    def test_generated_multipart_jwt_storage_recipient_retrieval_and_idempotency(self):
        for format in ('JPEG','PNG','WEBP'):
            with self.subTest(format=format):
                form = self.parse(format)
                file = form['file']
                self.addCleanup(file.file.close)
                key = str(uuid4())
                message, recipients = create_image_message(self.cid, self.actors[0].id, '', file, self.db, client_message_id=key)
                self.assertEqual(set(recipients),{self.actors[0].id,self.actors[1].id})
                file.file.seek(0)
                replay, events = create_image_message(self.cid,self.actors[0].id,'',file,self.db,client_message_id=key)
                self.assertEqual(message.id,replay.id)
                self.assertEqual(events,[])
                recipient = self.actors[1]
                download = download_image(message.attachment.id,recipient,self.db)
                self.assertEqual(download.headers['cache-control'],'private, no-store')
                with Image.open(download.path) as decoded:
                    decoded.load()
                    self.assertEqual(decoded.size,(180,320))
                self.assertIn(message.id,[item.id for item in get_messages(self.cid,recipient,self.db)])
                with self.assertRaises(HTTPException) as raised:
                    download_image(message.attachment.id,self.actors[2],self.db)
                self.assertEqual(raised.exception.status_code,404)
                self.assertEqual(self.db.scalar(select(func.count()).select_from(Message).where(Message.client_message_id==key)),1)

    def test_failed_transaction_cleans_file_and_retry_keeps_same_intent(self):
        file=self.parse('PNG')['file'];self.addCleanup(file.file.close)
        from app.core.config import UPLOAD_DIR
        before=set((UPLOAD_DIR/'images').glob('*'));key=str(uuid4())
        with patch.object(self.db,'commit',side_effect=RuntimeError('synthetic transaction failure')):
            with self.assertRaises(RuntimeError):
                create_image_message(self.cid,self.actors[0].id,'',file,self.db,client_message_id=key)
        self.assertEqual(set((UPLOAD_DIR/'images').glob('*')),before)
        self.assertEqual(self.db.scalar(select(func.count()).select_from(MessageAttachment)),0)
        file.file.seek(0)
        message,_=create_image_message(self.cid,self.actors[0].id,'',file,self.db,client_message_id=key)
        self.assertEqual(message.client_message_id,key)

    def test_jwt_rejection_happens_before_media_access(self):
        with self.assertRaises(HTTPException) as raised:
            get_current_user(HTTPAuthorizationCredentials(scheme='Bearer',credentials='invalid'),self.db)
        self.assertEqual(raised.exception.status_code,401)
