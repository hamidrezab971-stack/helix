"""Exercise production routing in isolated processes and temporary storage."""
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import textwrap
import unittest


class HostingTests(unittest.TestCase):
    def run_app_check(self, source, *, serve_frontend):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            frontend = directory / "frontend"
            frontend.mkdir()
            (frontend / "index.html").write_text("<html>Smooth production</html>")
            (frontend / "app.js").write_text("window.smooth = true;")
            environment = {
                **os.environ,
                "DATABASE_URL": f"sqlite:///{directory / 'smooth.db'}",
                "SECRET_KEY": secrets.token_urlsafe(48),
                "ACCESS_TOKEN_EXPIRE_MINUTES": "60",
                "FRONTEND_ORIGIN": "https://smooth.example",
                "UPLOAD_DIR": str(directory / "uploads"),
                "FRONTEND_DIST_DIR": str(frontend) if serve_frontend else "",
            }
            result = subprocess.run(
                [sys.executable, "-c", textwrap.dedent(source)],
                cwd=Path(__file__).resolve().parents[1],
                env=environment,
                capture_output=True,
                text=True,
                timeout=30,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_backend_only_retains_api_root(self):
        self.run_app_check("""
            from fastapi.testclient import TestClient
            from app.main import app
            with TestClient(app) as client:
                assert client.get('/').json() == {'message': 'Smooth API is running'}
                assert client.get('/api/health').json() == {'status': 'ok'}
        """, serve_frontend=False)

    def test_production_serves_frontend_api_websocket_and_durable_users(self):
        self.run_app_check("""
            from fastapi.testclient import TestClient
            from app.main import app
            account = {'username': 'hosting_test', 'password': 'hosting-test-password'}
            import sys
            sys.path.insert(0, 'tests')
            from captcha_support import protected_post
            with TestClient(app) as client:
                page = client.get('/')
                assert page.status_code == 200
                assert 'text/html' in page.headers['content-type']
                assert 'Smooth production' in page.text
                assert client.get('/app.js').text == 'window.smooth = true;'
                assert client.get('/api/health').json() == {'status': 'ok'}
                assert client.get('/api/auth/me').status_code == 401
                assert client.get('/api/unknown').status_code == 404
                assert client.get('/.env').status_code == 404
                registered = protected_post(client, '/api/auth/register', account)
                assert registered.status_code == 201
                user_id = registered.json()['id']
                token = protected_post(client, '/api/auth/login', account).json()['access_token']
                with client.websocket_connect('/ws', headers={'origin': 'https://smooth.example'}) as socket:
                    socket.send_json({'type': 'auth', 'token': token})
                    assert socket.receive_json() == {'type': 'auth:ok'}
                    assert socket.receive_json() == {
                        'type': 'presence:update', 'data': {'user_id': user_id, 'status': 'online'}
                    }
                    assert socket.receive_json() == {
                        'type': 'presence:snapshot', 'data': {'online_user_ids': [user_id]}
                    }
            # Re-enter the lifespan after engine disposal, using the same disk database.
            with TestClient(app) as client:
                response = protected_post(client, '/api/auth/login', account)
                assert response.status_code == 200
                assert response.json()['access_token']
        """, serve_frontend=True)
