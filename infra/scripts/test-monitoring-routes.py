#!/usr/bin/env python3
"""Exercise the real Nginx route templates on isolated loopback listeners.

The upstream is a test HTTP/WebSocket server, never Grafana or production.
This verifies the proxy/access contract, not Grafana rendering or delivery.
"""
import base64
import hashlib
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[1]


class Upstream(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        if self.headers.get('Upgrade', '').lower() == 'websocket':
            key = self.headers.get('Sec-WebSocket-Key', '')
            accept = base64.b64encode(hashlib.sha1(
                (key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
            self.send_response(101)
            self.send_header('Upgrade', 'websocket')
            self.send_header('Connection', 'Upgrade')
            self.send_header('Sec-WebSocket-Accept', accept)
            self.end_headers()
            return
        data = json.dumps({'path': self.path, 'headers': dict(self.headers)}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Set-Cookie', 'grafana_session=synthetic; Path=/grafana/')
        self.end_headers()
        self.wfile.write(data)

    do_POST = do_GET


def main():
    if not shutil.which('nginx'):
        raise RuntimeError('Nginx is required for this integration check')
    backend = ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
    thread = threading.Thread(target=backend.serve_forever, daemon=True)
    thread.start()
    nginx = None
    checks = 0
    try:
        with tempfile.TemporaryDirectory(prefix='helix-monitoring-nginx-') as tmp:
            work = Path(tmp)
            password = secrets.token_urlsafe(24)
            hashed = subprocess.check_output(['openssl', 'passwd', '-apr1', '-stdin'],
                                             input=(password + '\n').encode()).decode().strip()
            (work / 'htpasswd').write_text('integration-admin:' + hashed + '\nintegration-viewer:' + hashed + '\n')
            (work / 'admin.htpasswd').write_text('integration-admin:' + hashed + '\n')
            (work / 'index.html').write_text('HELIX monitoring navigation')
            access = (ROOT / 'nginx/monitoring-access.conf.example').read_text().replace(
                '/etc/nginx/helix-monitoring.htpasswd', str(work / 'htpasswd'))
            (work / 'access.conf').write_text(access)
            admin_access = (ROOT / 'nginx/monitoring-admin-access.conf.example').read_text().replace(
                '/etc/nginx/helix-monitoring-admin.htpasswd', str(work / 'admin.htpasswd'))
            (work / 'admin-access.conf').write_text(admin_access)
            routes = (ROOT / 'nginx/monitoring-routes.conf.example').read_text().replace(
                '/etc/nginx/snippets/helix-monitoring-access.conf', str(work / 'access.conf'))
            routes = routes.replace('/etc/nginx/snippets/helix-monitoring-admin-access.conf',
                                    str(work / 'admin-access.conf')).replace('/var/www/helix-monitoring', str(work))
            for port in (13000, 19090):
                routes = routes.replace('127.0.0.1:' + str(port),
                                        '127.0.0.1:' + str(backend.server_port))
            with socket.socket() as listener:
                listener.bind(('127.0.0.1', 0))
                port = listener.getsockname()[1]
            config = work / 'nginx.conf'
            config.write_text(f'''
master_process off;
daemon off;
pid {work}/nginx.pid;
error_log {work}/error.log;
events {{ worker_connections 32; }}
http {{
    access_log off;
    client_body_temp_path {work}/client;
    proxy_temp_path {work}/proxy;
    fastcgi_temp_path {work}/fastcgi;
    uwsgi_temp_path {work}/uwsgi;
    scgi_temp_path {work}/scgi;
    {(ROOT / 'nginx/monitoring-http.conf.example').read_text()}
    server {{
        listen 127.0.0.1:{port};
        server_name helix.localip.ir;
        {routes}
        location / {{ return 404; }}
    }}
}}
''')
            subprocess.run(['nginx', '-t', '-c', str(config), '-p', str(work)],
                           capture_output=True, check=True, timeout=10)
            nginx = subprocess.Popen(['nginx', '-c', str(config), '-p', str(work)],
                                     stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            for _ in range(50):
                try:
                    with socket.create_connection(('127.0.0.1', port), timeout=.1):
                        break
                except OSError:
                    if nginx.poll() is not None:
                        raise RuntimeError(nginx.stderr.read().decode())
                    time.sleep(.02)
            else:
                raise RuntimeError('Isolated Nginx failed to listen')
            authorized = 'Basic ' + base64.b64encode(
                ('integration-admin:' + password).encode()).decode()
            viewer = 'Basic ' + base64.b64encode(
                ('integration-viewer:' + password).encode()).decode()

            def request(path, expected, *, auth=None, source='127.0.0.1', headers=None):
                nonlocal checks
                supplied = {'Host': 'helix.localip.ir', **(headers or {})}
                if auth:
                    supplied['Authorization'] = auth
                conn = http.client.HTTPConnection('127.0.0.1', port, timeout=5,
                                                  source_address=(source, 0))
                try:
                    conn.request('GET', path, headers=supplied)
                    response = conn.getresponse()
                    body = response.read() if expected != 101 else b''
                    assert response.status == expected, (path, response.status, expected)
                    checks += 1
                    return response, body
                finally:
                    conn.close()

            paths = ['/grafana', '/grafana/', '/grafana/login',
                     '/grafana/public/build/example.js', '/grafana/api/live/ws',
                     '/prometheus', '/prometheus/', '/prometheus/api/v1/query?query=up']
            for path in paths:
                response, _ = request(path, 401)
                assert 'HELIX monitoring' in response.getheader('WWW-Authenticate')
                request(path, 401, auth='Basic aW52YWxpZDppbnZhbGlk')
                request(path, 401, source='127.0.0.2', headers={
                    'X-Forwarded-For': '127.0.0.1', 'X-Real-IP': '127.0.0.1'})
            for prefix in ('grafana', 'prometheus'):
                response, _ = request('/' + prefix, 308, auth=authorized)
                assert response.getheader('Location') == f'https://helix.localip.ir/{prefix}/'
            for path, upstream in [('/grafana/login', '/grafana/login'),
                                   ('/grafana/public/build/example.js', '/grafana/public/build/example.js'),
                                   ('/prometheus/api/v1/query?query=up', '/api/v1/query?query=up')]:
                response, body = request(path, 200, auth=authorized)
                data = json.loads(body)
                headers = {key.lower(): value for key, value in data['headers'].items()}
                assert data['path'] == upstream
                assert not headers.get('authorization')
                assert headers['x-forwarded-proto'] == 'https'
                assert headers['host'] == 'helix.localip.ir'
                if path.startswith('/grafana/'):
                    cookie = response.getheader('Set-Cookie').lower()
                    assert all(flag in cookie for flag in ('secure', 'httponly', 'samesite=lax', 'path=/grafana/'))
            request('/grafana/api/live/ws', 101, auth=authorized, headers={
                'Upgrade': 'websocket', 'Connection': 'Upgrade', 'Sec-WebSocket-Version': '13',
                'Sec-WebSocket-Key': base64.b64encode(secrets.token_bytes(16)).decode(),
                'Origin': 'https://helix.localip.ir'})
            request('/grafana/api/live/ws', 401, headers={'Upgrade': 'websocket', 'Connection': 'Upgrade'})
            request('/grafana/public/build/example.js', 200, auth=viewer, source='127.0.0.2')
            request('/prometheus/', 401, auth=viewer)
            request('/prometheus/api/v1/query?query=up', 401, auth=viewer)
            request('/monitoring/', 200, auth=viewer)
            request('/monitoring', 401)
            for path in ('/Grafana/api/user', '/grafana;bad/api/user', '/Prometheus/api/v1/query'):
                request(path, 404)
            for path in ('//grafana/api/user', '/%67rafana/api/user', '/grafana%2fapi/user',
                         '/prometheus//api/v1/query', '/%70rometheus/api/v1/query'):
                request(path, 401)
            for path in ('/prometheus/metrics', '/prometheus/api/v1/admin/tsdb/delete_series',
                         '/prometheus/-/reload', '/prometheus/-/healthy'):
                request(path, 404)
                request(path, 404, auth=authorized)
            rate_statuses = []
            for _ in range(16):
                connection = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
                connection.request('POST', '/grafana/login', headers={
                    'Host': 'helix.localip.ir', 'Authorization': authorized})
                response = connection.getresponse(); response.read()
                rate_statuses.append(response.status); connection.close(); checks += 1
            assert rate_statuses[0] == 200 and 429 in rate_statuses, rate_statuses
            print(json.dumps({'result': 'PASS', 'checks': checks,
                              'separate_viewer_and_admin_edge_access': True, 'spoofed_forwarding_denied': True,
                              'subpaths_cookies_and_live_proxy': True,
                              'login_rate_limit_verified': True,
                              'production_modified': False, 'grafana_delivery_verified': False}))
    finally:
        if nginx is not None:
            nginx.terminate()
            nginx.wait(timeout=10)
        backend.shutdown()
        backend.server_close()


if __name__ == '__main__':
    main()
