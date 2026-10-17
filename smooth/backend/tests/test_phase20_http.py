"""Real FastAPI transport checks. Requires an environment supporting TestClient."""
import unittest
from concurrent.futures import ThreadPoolExecutor
import test_phase8 as baseline
from captcha_support import captcha, protected_post
from app.main import app
from app.database.database import Base,engine
from fastapi.testclient import TestClient


class Phase20HTTPTests(unittest.TestCase):
    def setUp(self):
        Base.metadata.drop_all(engine)
        self.client=TestClient(app)
        self.client.__enter__();self.addCleanup(self.client.__exit__,None,None,None)

    def account(self):
        data={'username':'http_alice','password':'password123'}
        user=protected_post(self.client,'/api/auth/register',data)
        self.assertEqual(user.status_code,201,user.text)
        login=protected_post(self.client,'/api/auth/login',data)
        self.assertEqual(login.status_code,200,login.text)
        return {'Authorization':'Bearer '+login.json()['access_token']}

    def test_both_real_endpoints_require_captcha_and_sanitize_validation(self):
        for path in ('/api/auth/register','/api/auth/login'):
            result=self.client.post(path,json={'username':'alice','password':'plaintext-secret'})
            self.assertEqual(result.status_code,422)
            self.assertNotIn('plaintext-secret',result.text)
        def registered_routes(router):
            for route in router.routes:
                included=getattr(route,'original_router',None)
                if included is not None:
                    yield from registered_routes(included)
                elif hasattr(route,'methods'):
                    yield route.path,route.methods
        routes=list(registered_routes(app.router))
        self.assertEqual(sum(path=='/api/auth/login' and 'POST' in methods for path,methods in routes),1)

    def test_successful_auth_and_retry_preserve_contract(self):
        headers=self.account()
        self.assertEqual(self.client.get('/api/auth/me',headers=headers).status_code,200)
        body={'username':'http_alice','password':'wrong','altcha':captcha(self.client,'login')}
        self.assertEqual(self.client.post('/api/auth/login',json=body).status_code,401)
        body['password']='password123';body['altcha']=captcha(self.client,'login')
        self.assertEqual(self.client.post('/api/auth/login',json=body).status_code,200)

    def test_replay_under_concurrent_http_requests(self):
        headers=self.account()
        body={'username':'http_alice','password':'password123','altcha':captcha(self.client,'login')}
        with ThreadPoolExecutor(max_workers=4) as pool:results=list(pool.map(lambda _:self.client.post('/api/auth/login',json=body).status_code,range(4)))
        self.assertEqual(results.count(200),1);self.assertEqual(results.count(400),3)

    def test_challenge_issue_rate_limit_and_no_cache(self):
        for _ in range(30):
            response=self.client.get('/api/auth/challenge?purpose=login')
            self.assertEqual(response.status_code,200);self.assertEqual(response.headers['cache-control'],'no-store')
        self.assertEqual(self.client.get('/api/auth/challenge?purpose=login').status_code,429)
        self.assertEqual(self.client.get('/api/auth/challenge?purpose=other').status_code,422)

    def test_auth_request_size_limit_including_stream(self):
        self.assertEqual(self.client.post('/api/auth/login',content=b'x'*20000).status_code,413)
        self.assertEqual(self.client.post('/api/auth/login',content=iter([b'x'*9000,b'y'*9000])).status_code,413)

    def test_profiles_require_auth_and_do_not_expose_storage(self):
        for path in ('/api/profiles/me','/api/profiles/1','/api/profiles/photos/1/content'):
            self.assertEqual(self.client.get(path).status_code,401)
        headers=self.account()
        data=self.client.get('/api/profiles/me',headers=headers)
        self.assertEqual(data.status_code,200);self.assertNotIn('password_hash',data.text);self.assertNotIn('storage_name',data.text)

    def test_bio_save_unicode_limit_and_photo_upload_http(self):
        headers=self.account()
        text='سلام 😀\r\nHello'
        result=self.client.patch('/api/profiles/me',headers=headers,json={'biography':text})
        self.assertEqual(result.status_code,200);self.assertEqual(result.json()['biography'],text.replace('\r\n','\n'))
        self.assertEqual(self.client.patch('/api/profiles/me',headers=headers,json={'biography':'😀'*1001}).status_code,422)
        file=baseline.Phase8Tests.image_bytes(self)
        result=self.client.post('/api/profiles/me/photos',headers=headers,files={'file':('photo.png',file,'image/png')})
        self.assertEqual(result.status_code,201,result.text)
        photo=result.json()['primary_photo_id']
        content=self.client.get(f'/api/profiles/photos/{photo}/content',headers=headers)
        self.assertEqual(content.status_code,200);self.assertEqual(content.headers['content-type'],'image/webp')
        self.assertEqual(content.headers['cache-control'],'private, no-store')
        self.assertEqual(self.client.delete(f'/api/profiles/me/photos/{photo}',headers=headers).status_code,200)
