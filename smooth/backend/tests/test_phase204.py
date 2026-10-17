"""Real authenticated ASGI multipart, persistence, migration and WSS tests.

All accounts, files and databases are isolated by the existing Phase 8 fixture.
The real ALTCHA challenge/solution flow runs for registration and login.
"""
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
import unittest
from unittest.mock import patch
from uuid import uuid4

import test_phase8 as baseline
from captcha_support import protected_post
from PIL import Image
from sqlalchemy import select, text
from app.database.database import engine, SessionLocal
from app.database.phase204 import migrate_phase204
from app.models.message import Message
from app.models.conversation_visibility import ConversationVisibility
from app.services.sync import cursor
from app.services.visibility import private_message_event


class Phase204Tests(unittest.TestCase):
    setUp = baseline.Phase8Tests.setUp
    headers = baseline.Phase8Tests.headers
    authenticate = baseline.Phase8Tests.authenticate
    receive_type = baseline.Phase8Tests.receive_type
    image_bytes = baseline.Phase8Tests.image_bytes

    @property
    def cid(self): return int(self.path.split('/')[3])

    def send(self, content, name='alice', **extra):
        result = self.client.post(self.path, headers=self.headers(name), json={'content': content, **extra})
        self.assertEqual(result.status_code, 201, result.text)
        return result.json()

    def clear(self, name='alice'):
        result = self.client.delete(f'/api/conversations/{self.cid}', headers=self.headers(name))
        self.assertEqual(result.status_code, 200, result.text)
        return result.json()

    def page(self, name='alice', **params):
        result = self.client.get(self.path+'/page', headers=self.headers(name), params=params)
        self.assertEqual(result.status_code, 200, result.text)
        return result.json()

    def recent(self, name='alice'):
        return self.client.get('/api/conversations', headers=self.headers(name)).json()

    def test_real_multipart_formats_metadata_primary_gallery_and_permissions(self):
        previous_version = 0
        ids = []
        for fmt, mime, size in [('JPEG','image/jpeg',(1200,800)), ('PNG','image/png',(800,1200)), ('WEBP','image/webp',(700,700))]:
            with self.subTest(fmt=fmt):
                photo = Image.new('RGB', size, 'coral'); exif = Image.Exif(); exif[274]=6; exif[270]='private metadata'
                data=BytesIO(); photo.save(data, fmt, exif=exif)
                response=self.client.post('/api/profiles/me/photos', headers=self.headers('alice'), files={'file':('photo',data.getvalue(),mime)})
                self.assertEqual(response.status_code,201,response.text)
                gallery=response.json(); ids=[p['id'] for p in gallery['photos']]
                self.assertGreater(gallery['profile_version'],previous_version); previous_version=gallery['profile_version']
                content=self.client.get(f'/api/profiles/photos/{ids[-1]}/content',headers=self.headers('bob'))
                self.assertEqual(content.status_code,200)
                with Image.open(BytesIO(content.content)) as output:
                    self.assertEqual(output.size,(512,512));self.assertEqual(output.format,'WEBP')
                    self.assertFalse(output.getexif());self.assertFalse(set(output.info)&{'exif','icc_profile','xmp','comment'})
                self.assertNotIn(b'private metadata',content.content)
        self.assertEqual(len(ids),3)
        changed=self.client.patch(f'/api/profiles/me/photos/{ids[-1]}/primary',headers=self.headers('alice')).json()
        self.assertEqual(changed['primary_photo_id'],ids[-1])
        self.assertEqual(self.client.get('/api/profiles/me',headers=self.headers('alice')).json()['photos'],changed['photos'])
        for path in (f'/api/profiles/me/photos/{ids[0]}/primary',):
            self.assertEqual(self.client.patch(path,headers=self.headers('bob')).status_code,404)
        self.assertEqual(self.client.delete(f'/api/profiles/me/photos/{ids[0]}',headers=self.headers('bob')).status_code,404)
        self.assertEqual(self.client.post('/api/profiles/me/photos',files={'file':('x.png',b'x','image/png')}).status_code,401)
        self.assertEqual(self.client.get(f'/api/profiles/photos/{ids[0]}/content').status_code,401)

    def test_upload_validation_failure_and_retry_leave_gallery_intact(self):
        bad=self.client.post('/api/profiles/me/photos',headers=self.headers('alice'),files={'file':('bad.png',b'not an image','image/png')})
        self.assertEqual(bad.status_code,422)
        with patch('app.services.profile_images.os.open',side_effect=PermissionError('test only')):
            result=self.client.post('/api/profiles/me/photos',headers=self.headers('alice'),files={'file':('x.png',self.image_bytes(),'image/png')})
            self.assertEqual(result.status_code,503)
        self.assertEqual(self.client.get('/api/profiles/me',headers=self.headers('alice')).json()['photos'],[])
        response=self.client.post('/api/profiles/me/photos',headers=self.headers('alice'),files={'file':('x.png',self.image_bytes(),'image/png')})
        self.assertEqual(response.status_code,201,response.text)

    def test_clear_is_private_persistent_idempotent_and_reuses_identity(self):
        old=self.send('old history','bob')
        self.assertEqual(self.recent()[0]['unread_count'],1)
        first=self.clear(); self.assertEqual(self.clear(),first)
        self.assertEqual(self.recent(),[]);self.assertEqual(self.page()['items'],[])
        self.assertEqual(self.client.get(self.path,headers=self.headers('alice')).json(),[])
        self.assertEqual(self.page('bob')['items'][0]['id'],old['id'])
        self.tokens['alice']=protected_post(self.client,'/api/auth/login',{'username':'alice','password':'password123'}).json()['access_token']
        self.assertEqual(self.recent(),[])
        opened=self.client.post(f'/api/conversations/with/{self.users["bob"]}',headers=self.headers('alice'))
        self.assertEqual(opened.status_code,200);self.assertEqual(opened.json()['id'],self.cid)
        self.assertEqual(self.recent()[0]['unread_count'],0);self.assertIsNone(self.recent()[0]['last_message'])
        self.assertEqual(self.page()['items'],[])
        with SessionLocal() as db:
            self.assertIsNotNone(db.get(Message,old['id']))
            self.assertEqual(db.execute(text('SELECT count(*) FROM conversations')).scalar(),1)

    def test_new_message_revives_only_new_history_through_pagination_and_sync(self):
        old=self.send('cleared','bob'); before=self.page()
        self.clear()
        new=self.send('new','bob')
        self.assertEqual(self.recent()[0]['last_message']['id'],new['id']);self.assertEqual(self.recent()[0]['unread_count'],1)
        page=self.page(limit=1);self.assertEqual([m['id'] for m in page['items']],[new['id']]);self.assertFalse(page['has_older'])
        self.assertEqual(self.page(before=page['cursors'][str(new['id'])])['items'],[])
        self.assertEqual([m['id'] for m in self.page(after=before['cursors'][str(old['id'])])['items']],[new['id']])
        self.assertEqual(self.client.get(self.path+f'/{old["id"]}/context',headers=self.headers('alice')).status_code,404)
        stale=self.client.post(f'/api/conversations/{self.cid}/sync',params={'after':cursor('sync',self.cid,s=0)},headers=self.headers('alice'),json={'message_ids':[old['id']]})
        self.assertEqual(stale.status_code,409)
        result=self.client.post(f'/api/conversations/{self.cid}/sync',params={'after':page['sync_cursor']},headers=self.headers('alice'),json={'message_ids':[old['id'],new['id']]}).json()
        self.assertEqual(result['missing_ids'],[old['id']]);self.assertEqual([m['id'] for m in result['items']],[new['id']])
        self.assertEqual([m['id'] for m in self.page('bob')['items']],[old['id'],new['id']])

    def test_cleared_reply_attachment_reaction_mutation_and_send_replay_boundaries(self):
        client_id=str(uuid4()); old=self.send('private old',client_message_id=client_id)
        image=self.client.post(self.path+'/image',headers=self.headers('bob'),files={'file':('x.png',self.image_bytes(),'image/png')}).json()
        self.clear()
        self.assertEqual(self.client.get(f'/api/attachments/{image["attachment"]["id"]}/content',headers=self.headers('alice')).status_code,404)
        self.assertEqual(self.client.get(f'/api/attachments/{image["attachment"]["id"]}/content',headers=self.headers('bob')).status_code,200)
        self.assertEqual(self.client.get(f'/api/messages/{old["id"]}/reactions',headers=self.headers('alice')).status_code,404)
        self.assertEqual(self.client.patch(f'/api/messages/{old["id"]}',headers=self.headers('alice'),json={'content':'edit'}).status_code,404)
        self.assertEqual(self.client.delete(f'/api/messages/{old["id"]}',headers=self.headers('alice')).status_code,404)
        self.assertEqual(self.client.post(self.path,headers=self.headers('alice'),json={'content':'reply','reply_to_message_id':old['id']}).status_code,404)
        self.assertEqual(self.client.post(self.path,headers=self.headers('alice'),json={'content':'private old','client_message_id':client_id}).status_code,410)
        reply=self.send('reply from bob','bob',reply_to_message_id=old['id'])
        self.assertIsNone(self.page()['items'][0]['reply_to'])
        self.assertEqual(self.page('bob')['items'][-1]['reply_to']['id'],old['id'])
        filtered=private_message_event(self.users['alice'],{'type':'message:new','data':reply})
        self.assertIsNone(filtered['data']['reply_to'])

    def test_membership_unauthenticated_and_failed_commit_keep_chat(self):
        self.send('preserved')
        path=f'/api/conversations/{self.cid}'
        self.assertEqual(self.client.delete(path).status_code,401)
        self.assertEqual(self.client.delete(path,headers=self.headers('charlie')).status_code,404)
        self.assertEqual(self.client.delete('/api/conversations/99999',headers=self.headers('charlie')).status_code,404)
        with patch('sqlalchemy.orm.Session.commit',side_effect=RuntimeError('injected commit failure')):
            with self.assertRaises(RuntimeError): self.client.delete(path,headers=self.headers('alice'))
        self.assertEqual(len(self.recent()),1);self.assertEqual(len(self.page()['items']),1)

    def test_concurrent_send_and_delete_have_ordered_boundary(self):
        self.send('old','bob')
        with ThreadPoolExecutor(max_workers=2) as pool:
            deletion=pool.submit(self.clear)
            sent=pool.submit(self.send,'concurrent','bob')
            cutoff=deletion.result()['cleared_through_id'];new=sent.result()
        visible=[m['id'] for m in self.page()['items']]
        self.assertEqual(visible,[new['id']] if new['id']>cutoff else [])
        self.assertEqual(len(self.page('bob')['items']),2)

    def test_websocket_clear_scope_suppressed_old_edits_and_reconnect(self):
        old=self.send('before','bob')
        with self.client.websocket_connect('/ws') as alice,self.client.websocket_connect('/ws') as bob:
            self.authenticate(alice,'alice');self.authenticate(bob,'bob')
            self.clear()
            self.assertEqual(self.receive_type(alice,'conversation:cleared')['data']['conversation_id'],self.cid)
            edited=self.client.patch(f'/api/messages/{old["id"]}',headers=self.headers('bob'),json={'content':'still hidden'})
            self.assertEqual(edited.status_code,200)
            self.assertEqual(self.receive_type(bob,'message:updated')['data']['content'],'still hidden')
            alice.send_json({'type':'presence:heartbeat'})
            self.assertEqual(self.receive_type(alice,'presence:alive')['type'],'presence:alive')
            self.send('after','bob')
            self.assertEqual(self.receive_type(alice,'message:new')['data']['content'],'after')
        with self.client.websocket_connect('/ws') as alice:
            self.authenticate(alice,'alice')
            self.assertEqual([m['content'] for m in self.page()['items']],['after'])

    def test_additive_migration_idempotence_foreign_keys_and_preserved_records(self):
        self.send('keep')
        with engine.connect() as c:
            tables=['users','messages','conversations','conversation_members','message_receipts']
            before={t:c.execute(text('SELECT * FROM '+t+' ORDER BY rowid')).all() for t in tables}
        migrate_phase204(engine);migrate_phase204(engine)
        with engine.connect() as c:
            self.assertEqual(before,{t:c.execute(text('SELECT * FROM '+t+' ORDER BY rowid')).all() for t in tables})
            self.assertEqual(c.exec_driver_sql('PRAGMA foreign_key_check').all(),[])
            self.assertEqual(c.exec_driver_sql('PRAGMA integrity_check').scalar(),'ok')
            self.assertEqual(c.execute(text('SELECT count(*) FROM smooth_schema_migrations WHERE version=204')).scalar(),1)
        self.clear()
        with SessionLocal() as db:
            self.assertTrue(db.get(ConversationVisibility,(self.cid,self.users['alice'])).hidden)
