"""Real ASGI metrics and security checks using isolated SQLite and actual auth."""
import unittest
import test_hosting as hosting


class MetricsTests(unittest.TestCase):
    run_app_check = hosting.HostingTests.run_app_check

    def test_metrics_disabled_without_secret_even_with_frontend(self):
        self.run_app_check('''
            from fastapi.testclient import TestClient
            from app.main import app
            with TestClient(app) as client:
                for path in ('/internal/metrics', '/internal', '/internal/metrics/', '/internal/anything'):
                    assert client.get(path).status_code == 404
        ''', serve_frontend=True)

    def test_authentication_exposition_latency_and_bounded_labels(self):
        self.run_app_check('''
            import os, tempfile
            from pathlib import Path
            token = 'isolated-metrics-token-at-least-32-bytes'
            with tempfile.TemporaryDirectory() as directory:
                key = Path(directory)/'token'; key.write_text(token)
                os.environ['METRICS_TOKEN_FILE'] = str(key)
                from fastapi.testclient import TestClient
                from app.main import app
                with TestClient(app) as client:
                    auth = {'Authorization':'Bearer '+token}
                    for headers in ({}, {'Authorization':'Bearer wrong'}, {'Authorization':'Basic '+token}):
                        assert client.get('/internal/metrics',headers=headers).status_code == 404
                    assert client.post('/internal/metrics',headers=auth).status_code == 404
                    assert client.get('/internal/metrics/',headers=auth).status_code == 404
                    assert client.get('/internal/metrics',headers=[('Authorization','Bearer '+token),('Authorization','Bearer '+token)]).status_code == 404
                    assert client.get('/api/health').status_code == 200
                    for i in range(30):
                        assert client.get('/api/attachments/'+str(i+100000)+'/content?token=never-export-this').status_code == 401
                        client.get('/unknown-private-file-'+str(i))
                    assert client.post('/api/conversations/123456/messages/image').status_code == 401
                    assert client.post('/api/profiles/me/photos').status_code == 401
                    result=client.get('/internal/metrics',headers=auth)
                    assert result.status_code == 200
                    assert 'version=0.0.4' in result.headers['content-type']
                    assert result.headers['cache-control'] == 'no-store'
                    body=result.text
                    assert token not in body and 'never-export-this' not in body
                    # Numeric observations can legitimately contain "100000".
                    # Check the private request paths in labels explicitly.
                    assert all('route="/api/attachments/'+str(i+100000)+'/content"' not in body for i in range(30)), body
                    assert 'unknown-private-file' not in body
                    assert 'route="/api/attachments/{attachment_id}/content",status="401"} 30' in body, body
                    assert 'helix_http_request_duration_seconds_bucket{method="GET",route="/api/health",le="+Inf"} 1' in body
                    assert 'helix_uploads_total{kind="attachment",outcome="failure"} 1' in body
                    assert 'helix_uploads_total{kind="profile",outcome="failure"} 1' in body
                    assert 'process_cpu_seconds_total ' in body
                    # Scraping itself does not inflate request/latency counts.
                    assert '/internal/metrics' not in body
        ''', serve_frontend=True)

    def test_invalid_token_file_fails_closed(self):
        self.run_app_check('''
            import os,tempfile
            from pathlib import Path
            from fastapi.testclient import TestClient
            from app.main import app
            with tempfile.TemporaryDirectory() as directory:
                key=Path(directory)/'key';key.write_text('too short')
                os.environ['METRICS_TOKEN_FILE']=str(key)
                try:
                    with TestClient(app): pass
                except RuntimeError as error:
                    assert 'Metrics token' in str(error)
                else: raise AssertionError('Invalid metrics key accepted')
        ''', serve_frontend=False)


class RealtimeMetricsTests(unittest.TestCase):
    def test_real_auth_message_upload_delivery_disconnect_and_history(self):
        hosting.HostingTests.run_app_check(self, '''
            from io import BytesIO
            from PIL import Image
            import sys
            sys.path.insert(0,'tests')
            from captcha_support import protected_post
            from fastapi.testclient import TestClient
            from app.main import app
            from app.core.metrics import metrics
            def read_type(socket, kind):
                while True:
                    event=socket.receive_json()
                    if event['type']==kind: return event
            with TestClient(app) as client:
                tokens={};users={}
                for name in ('metricsalice','metricsbob'):
                    body={'username':name,'password':'metrics-test-password'}
                    users[name]=protected_post(client,'/api/auth/register',body).json()['id']
                    tokens[name]=protected_post(client,'/api/auth/login',body).json()['access_token']
                headers={'Authorization':'Bearer '+tokens['metricsalice']}
                conversation=client.post('/api/conversations/with/'+str(users['metricsbob']),headers=headers).json()
                path='/api/conversations/'+str(conversation['id'])+'/messages'
                with client.websocket_connect('/ws') as bob:
                    bob.send_json({'type':'auth','token':tokens['metricsbob']})
                    read_type(bob,'presence:snapshot')
                    assert metrics.connections==1
                    message=client.post(path,headers=headers,json={'content':'private message never in metrics'})
                    assert message.status_code==201
                    assert read_type(bob,'message:new')['data']['id']==message.json()['id']
                    image=BytesIO();Image.new('RGB',(8,8),'red').save(image,'PNG')
                    result=client.post(path+'/image',headers=headers,files={'file':('private-name.png',image.getvalue(),'image/png')})
                    assert result.status_code==201
                    assert read_type(bob,'message:new')['data']['id']==result.json()['id']
                    assert client.post(path+'/image',headers=headers,files={'file':('bad.png',b'invalid','image/png')}).status_code==422
                assert metrics.connections==0
                assert metrics.disconnects==1
                assert metrics.deliveries['message:new','success']==2
                body=metrics.render().decode()
                assert 'helix_uploads_total{kind="attachment",outcome="success"} 1' in body
                assert 'helix_uploads_total{kind="attachment",outcome="failure"} 1' in body
                assert 'private message' not in body and 'private-name' not in body
                assert len(client.get(path,headers=headers).json())==2
        ''', serve_frontend=False)
