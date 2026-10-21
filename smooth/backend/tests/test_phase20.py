"""SQLite/endpoint-service tests runnable without a listening network socket.

Existing TestClient and browser suites separately exercise the HTTP transport.
These tests use real signatures, KDFs, Argon2, transactions and decoded images.
"""
import base64
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

import test_phase8 as isolated  # establishes temporary DB/uploads before app imports
from fastapi import HTTPException, UploadFile
from pydantic import ValidationError
from PIL import Image
from sqlalchemy import create_engine, event, text
from starlette.requests import Request

from app.api.auth import login, register_user
from app.api import profiles
from app.core.auth import authenticate_access_token
from app.core.config import UPLOAD_DIR, CAPTCHA_KEY
from app.core.security import hash_password, create_access_token
from app.database.database import Base, SessionLocal, engine
from app.database.migrations import migrate_phase17, migrate_phase18
from app.database.phase20 import migrate_phase20
from app.models.user import User
from app.schemas.auth import LoginRequest, RegistrationRequest, UserResponse
from app.schemas.profile import BiographyUpdate
from app.services import antibot, profile_images
from app.vendor.altcha import Challenge, Payload, solve_challenge


def request(ip='192.0.2.8', forwarded=None):
    return Request({'type':'http','client':(ip,1234),'headers':[(b'x-forwarded-for',forwarded.encode())] if forwarded else []})


class Phase20Tests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.password_hash = hash_password('password123')

    def setUp(self):
        Base.metadata.drop_all(engine)
        Base.metadata.create_all(engine)
        migrate_phase17(engine); migrate_phase18(engine); migrate_phase20(engine)
        directory=UPLOAD_DIR/'profiles'
        if directory.is_symlink(): directory.unlink()
        if directory.exists(): shutil.rmtree(directory)
        self.db=SessionLocal();self.addCleanup(self.db.close)
        self.alice=User(username='alice',password_hash=self.password_hash)
        self.bob=User(username='bob',password_hash=self.password_hash)
        self.db.add_all([self.alice,self.bob]);self.db.commit()

    def solution(self,purpose='login',ip='192.0.2.8'):
        data=antibot.issue(request(ip),purpose)
        challenge=Challenge.from_dict(data)
        solved=solve_challenge(challenge)
        self.assertIsNotNone(solved)
        return Payload(challenge,solved).to_base64()

    def photo(self,size=(700,300),format='JPEG',exif=None):
        stream=BytesIO();Image.new('RGB',size,'#71b99b').save(stream,format,**({'exif':exif} if exif else {}));stream.seek(0)
        return UploadFile(stream,filename='../../avatar.exe')

    def upload(self,user=None,file=None):
        return profiles.upload(user or self.alice,self.db,file or self.photo())

    def error(self,code,fn,*args,**kwargs):
        with self.assertRaises(HTTPException) as caught:fn(*args,**kwargs)
        self.assertEqual(caught.exception.status_code,code)

    def test_registration_with_valid_challenge(self):
        data=RegistrationRequest(username='new_user',password='password123',altcha=self.solution('register'))
        user=register_user(data,request(),self.db)
        self.assertTrue(user.password_hash.startswith('$argon2'))
        self.assertEqual(user.username,'new_user')

    def test_missing_captcha_both_schemas_rejected(self):
        for schema in (LoginRequest,RegistrationRequest):
            with self.assertRaises(ValidationError):schema(username='alice',password='password123')

    def test_forged_challenge_rejected(self):
        data=json.loads(base64.b64decode(self.solution()))
        data['challenge']['signature']='a'*64
        self.error(400,antibot.consume,base64.b64encode(json.dumps(data).encode()).decode(),'login')

    def test_attacker_cannot_amplify_kdf_parameters(self):
        data=json.loads(base64.b64decode(self.solution()))
        data['challenge']['parameters']['cost']=2**63
        self.error(400,antibot.consume,base64.b64encode(json.dumps(data).encode()).decode(),'login')

    def test_expired_challenge_rejected(self):
        payload=self.solution()
        with engine.begin() as c:c.execute(text('UPDATE auth_challenges SET expires_at=1'))
        self.error(400,antibot.consume,payload,'login')

    def test_replay_rejected(self):
        payload=self.solution();antibot.consume(payload,'login')
        self.error(400,antibot.consume,payload,'login')

    def test_atomic_concurrent_reuse(self):
        payload=self.solution()
        def consume(_):
            try:antibot.consume(payload,'login');return True
            except HTTPException:return False
        with ThreadPoolExecutor(max_workers=6) as pool:results=list(pool.map(consume,range(6)))
        self.assertEqual(sum(results),1)

    def test_challenge_purpose_is_bound(self):
        self.error(400,antibot.consume,self.solution('register'),'login')

    def test_malformed_captcha_has_safe_error(self):
        for data in ('!', 'e30=', 'null', 'a'*8193):self.error(400,antibot.consume,data,'login')

    def test_login_contract_and_old_jwt_remain_compatible(self):
        old=create_access_token(self.alice.id,'alice')
        result=login(LoginRequest(username='alice',password='password123',altcha=self.solution()),request(),self.db)
        self.assertEqual(result.token_type,'bearer')
        for token in (old,result.access_token):self.assertEqual(authenticate_access_token(token,self.db)[0].id,self.alice.id)

    def test_invalid_password_generic_failure_and_consumed_challenge(self):
        payload=self.solution()
        self.error(401,login,LoginRequest(username='alice',password='wrong',altcha=payload),request(),self.db)
        self.error(400,antibot.consume,payload,'login')

    def test_unknown_user_same_login_error(self):
        self.error(401,login,LoginRequest(username='unknown',password='wrong',altcha=self.solution()),request(),self.db)

    def test_rate_limits_and_retry_after(self):
        for _ in range(3):antibot.quota('test','ip',3,60)
        with self.assertRaises(HTTPException) as e:antibot.quota('test','ip',3,60)
        self.assertEqual(e.exception.status_code,429);self.assertGreater(int(e.exception.headers['Retry-After']),0)

    def test_registration_ip_login_ip_account_and_challenge_quotas(self):
        cases=[('register-ip','192.0.2.8',20,900,lambda:antibot.auth_limits(request(),'register','new')),
               ('login-ip','192.0.2.8',60,900,lambda:antibot.auth_limits(request(),'login','alice')),
               ('account','alice',20,900,lambda:antibot.auth_limits(request('192.0.2.9'),'login','alice')),
               ('challenge','192.0.2.8',30,300,lambda:antibot.issue(request(),'login'))]
        for scope,key,limit,window,fn in cases:
            with engine.begin() as c:c.execute(text('DELETE FROM auth_rate_buckets'))
            for _ in range(limit):antibot.quota(scope,key,limit,window)
            self.error(429,fn)

    def test_progressive_failure_backoff(self):
        key=antibot.auth_limits(request(),'login','alice')
        for _ in range(4):antibot.outcome(key,False)
        self.error(429,antibot.auth_limits,request(),'login','alice')
        antibot.outcome(key,True)
        antibot.auth_limits(request(),'login','alice')

    def test_forwarded_header_is_never_trusted_by_app(self):
        self.assertEqual(antibot.address(request(forwarded='8.8.8.8')),'192.0.2.8')
        self.assertEqual(antibot.address(request('2001:db8:1::f')),'2001:db8:1::/64')

    def test_persistent_state_caps_fail_closed_and_expired_rows_cleanup(self):
        with patch.object(antibot,'MAX_BUCKETS',1):
            antibot.quota('a','one',1,60);self.error(503,antibot.quota,'b','two',1,60)
        with patch.object(antibot,'MAX_CHALLENGES',0):self.error(503,antibot.issue,request(),'login')
        with engine.begin() as c:c.execute(text('UPDATE auth_rate_buckets SET reset_at=1'))
        antibot.quota('b','two',1,60)
        with engine.connect() as c:self.assertEqual(c.scalar(text('SELECT count(*) FROM auth_rate_buckets')),1)

    def test_argon2_work_is_bounded_and_released(self):
        with antibot.password_work(),antibot.password_work():
            self.error(503,lambda:antibot.password_work().__enter__())
        with engine.connect() as c:self.assertEqual(c.scalar(text('SELECT count(*) FROM auth_work_leases')),0)

    def test_image_decode_work_is_bounded_independently_from_passwords(self):
        with antibot.image_work(),antibot.image_work(),antibot.password_work():
            self.error(503,lambda:antibot.image_work().__enter__())
        with engine.connect() as c:self.assertEqual(c.scalar(text('SELECT count(*) FROM auth_work_leases')),0)

    def test_challenge_failure_recovery_uses_new_solution(self):
        self.error(400,antibot.consume,'bad','login')
        antibot.consume(self.solution(),'login')

    def test_biography_save_load_clear_and_unicode(self):
        value='سلام دنیا 👩🏽‍💻\r\nHello <script>alert(1)</script>'
        result=profiles.biography(BiographyUpdate(biography=value),self.alice,self.db)
        self.assertEqual(result.biography,value.replace('\r\n','\n'))
        self.assertEqual(profiles.public(self.alice.id,self.bob,self.db).biography,result.biography)
        self.assertEqual(profiles.biography(BiographyUpdate(biography=''),self.alice,self.db).biography,'')

    def test_bio_unicode_limit_and_invalid_unicode(self):
        self.assertEqual(len(BiographyUpdate(biography='😀'*1000).biography),1000)
        for value in ('😀'*1001,'\x00','\ud800'):
            with self.assertRaises(ValidationError):BiographyUpdate(biography=value)
        self.assertEqual(len(BiographyUpdate(biography='\r\n'*1000).biography),1000)

    def test_database_also_enforces_bio_limit(self):
        from sqlalchemy.exc import IntegrityError
        with self.assertRaises(IntegrityError):
            with engine.begin() as c:c.execute(text('UPDATE users SET biography=:b WHERE id=1'),{'b':'x'*1001})

    def test_non_square_photo_is_normalized_and_primary_selected(self):
        result=self.upload();self.assertEqual(len(result.photos),1)
        self.assertEqual(result.primary_photo_id,result.photos[0].id)
        self.assertEqual((result.photos[0].width,result.photos[0].height),(512,512))

    def test_real_content_not_filename_or_mime(self):
        for format in ('JPEG','PNG','WEBP'):self.upload(file=self.photo(format=format))
        self.assertEqual(len(profiles.current(self.alice,self.db).photos),3)

    def test_metadata_removed_including_exif_orientation(self):
        exif=Image.Exif();exif[274]=6;exif[270]='private GPS metadata marker'
        result=self.upload(file=self.photo(exif=exif))
        content=profiles.content(result.primary_photo_id,self.bob,self.db)
        with Image.open(BytesIO(content.body)) as image:
            self.assertEqual(image.size,(512,512));self.assertFalse(image.getexif());self.assertNotIn('exif',image.info)
        self.assertNotIn(b'private GPS',content.body)

    def test_exif_orientation_is_applied_before_square_normalization(self):
        source=Image.new('RGB',(160,80),'red');source.paste('blue',(80,0,160,80))
        exif=Image.Exif();exif[274]=6
        stream=BytesIO();source.save(stream,'JPEG',exif=exif);stream.seek(0)
        data=profile_images.normalize(UploadFile(stream,filename='rotated.jpg'))
        with Image.open(BytesIO(data)) as image:
            top=image.getpixel((256,40));bottom=image.getpixel((256,470))
            self.assertGreater(top[0],top[2]);self.assertGreater(bottom[2],bottom[0])

    def test_malformed_unsupported_and_animated_rejected(self):
        self.error(422,self.upload,file=UploadFile(BytesIO(b'not an image'),filename='x.webp'))
        self.error(422,self.upload,file=self.photo(format='GIF'))
        stream=BytesIO();Image.new('RGB',(16,16),'red').save(stream,'WEBP',save_all=True,append_images=[Image.new('RGB',(16,16),'blue')],duration=100);stream.seek(0)
        self.error(422,self.upload,file=UploadFile(stream,filename='x.webp'))

    def test_byte_and_pixel_limits(self):
        self.error(413,self.upload,file=UploadFile(BytesIO(b'x'*(profile_images.MAX_BYTES+1)),filename='x.png'))
        with patch.object(profile_images,'MAX_PIXELS',100):self.error(422,self.upload,file=self.photo())

    def test_multiple_photos_primary_change_and_public_privacy(self):
        self.upload();result=self.upload();target=result.photos[1].id
        result=profiles.primary(target,self.alice,self.db)
        self.assertEqual(result.primary_photo_id,target)
        public=profiles.public(self.alice.id,self.bob,self.db).model_dump()
        self.assertFalse({'password_hash','storage_name','last_seen_at'} & public.keys())
        self.assertNotIn('storage_name',public['photos'][0])
        self.assertEqual(UserResponse.model_validate(self.alice).primary_photo_id,target)

    def test_nonprimary_deletion_and_primary_fallback(self):
        self.upload();self.upload();result=self.upload();ids=[p.id for p in result.photos]
        self.assertEqual(profiles.delete(ids[1],self.alice,self.db).primary_photo_id,ids[0])
        self.assertEqual(profiles.delete(ids[0],self.alice,self.db).primary_photo_id,ids[2])
        self.assertIsNone(profiles.delete(ids[2],self.alice,self.db).primary_photo_id)
        self.assertFalse(list((UPLOAD_DIR/'profiles').glob('*')))

    def test_cross_owner_cannot_select_or_delete_photo(self):
        result=self.upload()
        for fn in (profiles.primary,profiles.delete):self.error(404,fn,result.primary_photo_id,self.bob,self.db)
        self.assertEqual(len(profiles.current(self.alice,self.db).photos),1)

    def test_concurrent_deletion_idempotency_and_primary_integrity(self):
        self.upload();result=self.upload();target=result.primary_photo_id;user_id=self.alice.id
        def remove(_):
            with SessionLocal() as db:return profiles.delete(target,db.get(User,user_id),db).primary_photo_id
        self.db.rollback()
        with ThreadPoolExecutor(max_workers=4) as pool:result=list(pool.map(remove,range(4)))
        self.assertEqual(len(set(result)),1);self.assertIsNotNone(result[0])

    def test_concurrent_upload_cap_and_unique_order(self):
        user_id=self.alice.id
        def upload(_):
            with SessionLocal() as db:
                for _ in range(40):
                    try:return profiles.upload(db.get(User,user_id),db,self.photo()).primary_photo_id
                    except HTTPException as error:
                        if error.status_code!=503:return error.status_code
                        time.sleep(.025)
                return 503
        self.db.rollback()
        with patch.object(profiles,'PROFILE_MAX_PHOTOS',2),ThreadPoolExecutor(max_workers=4) as pool:
            results=list(pool.map(upload,range(4)))
        self.assertEqual(results.count(409),2)
        with engine.connect() as c:
            rows=c.execute(text('SELECT position FROM user_profile_photos ORDER BY position')).scalars().all()
            self.assertEqual(rows,[0,1])
            self.assertEqual(c.scalar(text('SELECT count(*) FROM profile_file_gc')),0)

    def test_primary_pointer_constraints(self):
        from sqlalchemy.exc import IntegrityError
        a=self.upload().primary_photo_id;b=self.upload(user=self.bob).primary_photo_id
        for value in (None,b):
            with self.assertRaises(IntegrityError):
                with engine.begin() as c:c.execute(text('UPDATE users SET primary_photo_id=:p WHERE id=:id'),{'p':value,'id':self.alice.id})

    def test_failed_file_write_has_no_photo_or_leaked_intent(self):
        with patch('app.services.profile_images.os.open',side_effect=OSError('disk full')):
            self.error(503,self.upload)
        with engine.connect() as c:self.assertEqual(c.scalar(text('SELECT count(*) FROM user_profile_photos')),0)
        profile_images.collect()
        with engine.connect() as c:self.assertEqual(c.scalar(text('SELECT count(*) FROM profile_file_gc')),0)

    def test_failed_db_insert_removes_created_file(self):
        def fail(c,cursor,statement,params,context,executemany):
            if statement.startswith('INSERT INTO user_profile_photos'):raise RuntimeError('injected storage transaction failure')
        event.listen(engine,'before_cursor_execute',fail)
        try:
            with self.assertRaises(RuntimeError):self.upload()
        finally:event.remove(engine,'before_cursor_execute',fail)
        self.assertFalse(list((UPLOAD_DIR/'profiles').glob('*')))
        self.assertEqual(len(profiles.current(self.alice,self.db).photos),0)

    def test_delete_cleanup_failure_is_durable_and_retryable(self):
        target=self.upload().primary_photo_id
        with patch.object(profile_images,'unlink',side_effect=OSError('unavailable')):profiles.delete(target,self.alice,self.db)
        self.assertEqual(len(list((UPLOAD_DIR/'profiles').glob('*'))),1)
        with engine.connect() as c:self.assertEqual(c.scalar(text('SELECT count(*) FROM profile_file_gc')),1)
        profile_images.collect();self.assertFalse(list((UPLOAD_DIR/'profiles').glob('*')))

    def test_failed_upload_directory_sync_does_not_commit_a_photo(self):
        import os
        import stat
        original_sync = os.fsync
        failed = []
        def fail_created_entry(fd):
            if stat.S_ISDIR(os.fstat(fd).st_mode) and any(name.endswith('.webp') for name in os.listdir(fd)):
                failed.append(True)
                raise OSError('injected directory sync failure')
            return original_sync(fd)
        with patch.object(profile_images.os, 'fsync', side_effect=fail_created_entry):
            self.error(503, self.upload)
        self.assertTrue(failed)
        with engine.connect() as connection:
            self.assertEqual(connection.scalar(text('SELECT count(*) FROM user_profile_photos')), 0)
            self.assertEqual(connection.scalar(text('SELECT count(*) FROM profile_file_gc')), 0)
        self.assertFalse(list((UPLOAD_DIR/'profiles').glob('*')))

    def test_failed_delete_directory_sync_retains_gc_intent_until_retry(self):
        import os
        import stat
        target = self.upload().primary_photo_id
        original_sync = os.fsync
        directory_inode = (UPLOAD_DIR/'profiles').stat().st_ino
        def fail_directory(fd):
            metadata = os.fstat(fd)
            if stat.S_ISDIR(metadata.st_mode) and metadata.st_ino == directory_inode:
                raise OSError('injected deletion sync failure')
            return original_sync(fd)
        with patch.object(profile_images.os, 'fsync', side_effect=fail_directory):
            result = profiles.delete(target, self.alice, self.db)
        self.assertIsNone(result.primary_photo_id)
        self.assertFalse(list((UPLOAD_DIR/'profiles').glob('*')))
        with engine.connect() as connection:
            self.assertEqual(connection.scalar(text('SELECT count(*) FROM user_profile_photos')), 0)
            self.assertEqual(connection.scalar(text('SELECT count(*) FROM profile_file_gc')), 1)
        profile_images.collect()
        with engine.connect() as connection:
            self.assertEqual(connection.scalar(text('SELECT count(*) FROM profile_file_gc')), 0)
        self.assertFalse(list((UPLOAD_DIR/'profiles').glob('*')))

    def test_namespace_symlink_and_path_traversal(self):
        for name in ('../elsewhere','0'*32+'.png'):
            with self.assertRaises(ValueError):profile_images.read(name)
        UPLOAD_DIR.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory() as outside:
            (UPLOAD_DIR/'profiles').symlink_to(outside,target_is_directory=True)
            self.error(503,self.upload)
            self.assertEqual(list(Path(outside).iterdir()),[])
            (UPLOAD_DIR/'profiles').unlink()

    def test_deleted_ids_not_reused_by_avatar_cache(self):
        first=self.upload().primary_photo_id;profiles.delete(first,self.alice,self.db)
        self.assertGreater(self.upload().primary_photo_id,first)

    def test_profile_mutations_preserve_message_attachment_reaction_and_receipt_data(self):
        from app.services.images import store_image,image_path
        stored=store_image(self.photo())
        with engine.begin() as c:
            c.execute(text('INSERT INTO conversations(id,user_low_id,user_high_id) VALUES (8,1,2)'))
            c.execute(text('INSERT INTO conversation_members(conversation_id,user_id) VALUES (8,1),(8,2)'))
            c.execute(text("INSERT INTO messages(id,conversation_id,sender_id,content) VALUES (42,8,1,'Original محفوظ')"))
            c.execute(text('''INSERT INTO message_attachments(message_id,kind,storage_name,mime_type,size_bytes,width,height)
              VALUES (42,'image',:storage_name,:mime_type,:size_bytes,:width,:height)'''),stored)
            c.execute(text("INSERT INTO message_reactions(message_id,user_id,emoji) VALUES (42,2,'❤️')"))
            c.execute(text('INSERT INTO message_receipts(message_id,recipient_id) VALUES (42,2)'))
        tables=['messages','message_attachments','message_reactions','message_receipts','conversations','conversation_members']
        with engine.connect() as c:before={name:c.execute(text('SELECT * FROM '+name)).all() for name in tables}
        original=image_path(stored['storage_name']).read_bytes()
        target=self.upload().primary_photo_id
        profiles.biography(BiographyUpdate(biography='New bio'),self.alice,self.db)
        profiles.delete(target,self.alice,self.db)
        with engine.connect() as c:self.assertEqual(before,{name:c.execute(text('SELECT * FROM '+name)).all() for name in tables})
        self.assertEqual(image_path(stored['storage_name']).read_bytes(),original)

    def test_profile_events_only_target_own_sessions_and_authorized_peers(self):
        from fastapi import BackgroundTasks
        with engine.begin() as c:
            c.execute(text('INSERT INTO conversations(id,user_low_id,user_high_id) VALUES (8,1,2)'))
            c.execute(text('INSERT INTO conversation_members(conversation_id,user_id) VALUES (8,1),(8,2)'))
        tasks=BackgroundTasks()
        first=profiles.current(self.alice,self.db).profile_version
        result=profiles.biography(BiographyUpdate(biography='Versioned'),self.alice,self.db,tasks)
        self.assertGreater(result.profile_version,first)
        task=tasks.tasks[0];self.assertEqual(set(task.args[0]),{1,2})
        self.assertEqual(task.args[1],{'type':'profile:update','data':{'id':1,'primary_photo_id':None,'profile_version':result.profile_version}})

    def test_migration_preserves_real_previous_schema_and_code_rollback(self):
        previous=Path(os.getenv('HELIX_PREVIOUS_SOURCE','/opt/helix/current'))
        if not previous.is_dir():self.skipTest('Set HELIX_PREVIOUS_SOURCE to approved Phase 19.1 source')
        with tempfile.TemporaryDirectory() as root:
            path=Path(root)/'legacy.db'
            env={**os.environ,'DATABASE_URL':'sqlite:///'+str(path),'UPLOAD_DIR':str(Path(root)/'uploads'),'FRONTEND_DIST_DIR':''}
            source='''from app.database.database import Base,engine
from app.main import app
from app.database.migrations import migrate_phase17,migrate_phase18
Base.metadata.create_all(engine);migrate_phase17(engine);migrate_phase18(engine)
'''
            subprocess.run([sys.executable,'-c',source],cwd=previous/'smooth/backend',env=env,check=True,capture_output=True,timeout=30)
            with sqlite3.connect(path) as c:
                c.execute("INSERT INTO users(id,username,password_hash) VALUES (91,'legacy',?)",(self.password_hash,))
                c.execute("INSERT INTO users(id,username,password_hash) VALUES (92,'peer',?)",(self.password_hash,))
                c.execute('INSERT INTO conversations(id,user_low_id,user_high_id) VALUES (1,91,92)')
                c.execute('INSERT INTO conversation_members(conversation_id,user_id) VALUES (1,91),(1,92)')
                c.execute("INSERT INTO messages(id,conversation_id,sender_id,content) VALUES (7,1,91,'پیام قدیمی')")
                c.execute("INSERT INTO message_reactions(message_id,user_id,emoji) VALUES (7,92,'❤️')")
                c.execute('INSERT INTO message_receipts(message_id,recipient_id) VALUES (7,92)')
                before={t:c.execute('SELECT count(*) FROM '+t).fetchone()[0] for (t,) in c.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}
                oldhash=c.execute('SELECT password_hash FROM users WHERE id=91').fetchone()[0]
            clone=create_engine('sqlite:///'+str(path));migrate_phase20(clone);migrate_phase20(clone)
            with sqlite3.connect(path) as c:
                for table,count in before.items():
                    if table!='smooth_schema_migrations':self.assertEqual(c.execute('SELECT count(*) FROM '+table).fetchone()[0],count)
                self.assertEqual(c.execute('SELECT id,password_hash,biography,primary_photo_id FROM users WHERE id=91').fetchone(),(91,oldhash,None,None))
                self.assertEqual(c.execute('PRAGMA integrity_check').fetchone()[0],'ok');self.assertEqual(c.execute('PRAGMA foreign_key_check').fetchall(),[])
                c.execute("UPDATE users SET biography='بیوی جدید 😀' WHERE id=91")
                c.execute("INSERT INTO user_profile_photos(user_id,storage_name,position,width,height,size_bytes) VALUES (91,'00000000000000000000000000000000.webp',0,512,512,128)")
            rollback=source+'''from app.models.user import User
from app.database.database import SessionLocal
from app.core.security import verify_password
with SessionLocal() as db:
 u=db.get(User,91)
 assert u.username=='legacy' and verify_password('password123',u.password_hash)
'''
            subprocess.run([sys.executable,'-c',rollback],cwd=previous/'smooth/backend',env=env,check=True,capture_output=True,timeout=30)
            with sqlite3.connect(path) as c:
                self.assertEqual(c.execute('SELECT biography,primary_photo_id FROM users WHERE id=91').fetchone(),('بیوی جدید 😀',1))
                self.assertEqual(c.execute('SELECT content FROM messages WHERE id=7').fetchone()[0],'پیام قدیمی')
            clone.dispose()


class IdentityBodyLimitTests(unittest.TestCase):
    def run_body(self,chunks,headers=(),path='/api/auth/login'):
        import asyncio
        from app.core.body_limits import IdentityBodyLimit
        sent=[];called=[]
        messages=[{'type':'http.request','body':chunk,'more_body':i<len(chunks)-1} for i,chunk in enumerate(chunks)]
        async def receive():return messages.pop(0)
        async def send(message):sent.append(message)
        async def endpoint(scope,receive,send):
            called.append(True)
            while (await receive()).get('more_body'):pass
            await send({'type':'http.response.start','status':204,'headers':[]})
        asyncio.run(IdentityBodyLimit(endpoint)({'type':'http','path':path,'headers':headers},receive,send))
        return sent,called

    def test_chunked_body_is_rejected_before_endpoint(self):
        sent,called=self.run_body([b'a'*9000,b'b'*9000]);self.assertEqual(sent[0]['status'],413);self.assertFalse(called)

    def test_content_length_is_rejected_before_read(self):
        sent,called=self.run_body([],[(b'content-length',b'999999')]);self.assertEqual(sent[0]['status'],413);self.assertFalse(called)

    def test_small_body_is_replayed_without_corruption(self):
        sent,called=self.run_body([b'{',b'}']);self.assertEqual(sent[0]['status'],204);self.assertEqual(called,[True])


if __name__=='__main__':unittest.main()
