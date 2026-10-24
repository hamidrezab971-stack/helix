#!/usr/bin/env python3
"""Production HTTPS security contract; never emits credentials or session data."""
import base64
import http.client
import json
from pathlib import Path
import socket
import ssl
import time

HOST = 'helix.localip.ir'
Q = Path('/root/helix-phase21.3')


def main():
    credentials = {role: json.loads((Path('/etc/helix/monitoring-handoff') / (role + '.json')).read_text())
                   for role in ['administrator', 'stakeholder']}
    checks = []

    def request(path, expected, role=None, method='GET', payload=None, headers=None):
        h = dict(headers or {})
        if role:
            edge = credentials[role]['edge']
            h['Authorization'] = 'Basic ' + base64.b64encode((edge['username'] + ':' + edge['password']).encode()).decode()
        body = None
        if payload is not None: body = json.dumps(payload); h['Content-Type'] = 'application/json'
        conn = http.client.HTTPSConnection(HOST, timeout=15, context=ssl.create_default_context())
        try:
            conn.request(method, path, body, h)
            r = conn.getresponse(); data = r.read()
            assert r.status in expected, f'{method} {path}: {r.status}; expected {expected}'
            assert not any(value['password'].encode() in data for account in credentials.values()
                           for value in account.values()), 'A response exposed a protected credential; value withheld'
            checks.append({'path': path, 'role': role or 'anonymous', 'method': method, 'status': r.status})
            return r, data
        finally: conn.close()

    paths = ['/grafana', '/grafana/', '/grafana/login', '/grafana/api/user', '/grafana/api/search',
        '/grafana/api/health', '/grafana/public/build/test.js', '/grafana/api/live/ws',
        '/prometheus', '/prometheus/', '/prometheus/query', '/prometheus/targets',
        '/prometheus/api/v1/query?query=up', '/prometheus/api/v1/status/config', '/monitoring', '/monitoring/']
    for path in paths:
        r, _ = request(path, [401])
        assert 'HELIX monitoring' in r.getheader('WWW-Authenticate', '')
        request(path, [401], headers={'Authorization': 'Basic aW52YWxpZDppbnZhbGlk',
            'X-Forwarded-For': '127.0.0.1', 'X-Real-IP': '127.0.0.1'})
    for role, value in credentials.items():
        invalid = 'Basic ' + base64.b64encode(
            (value['edge']['username'] + ':deliberately-invalid-password').encode()).decode()
        request('/grafana/login', [401], headers={'Authorization': invalid})
        checks[-1]['role'] = role + ' with incorrect password'
    value = credentials['administrator']['edge']
    invalid = 'Basic ' + base64.b64encode((value['username'] + ':deliberately-invalid-password').encode()).decode()
    request('/prometheus/', [401], headers={'Authorization': invalid})
    checks[-1]['role'] = 'administrator with incorrect password'
    for path in ['/Grafana/api/user', '/grafana;bad/api/user', '/Prometheus/api/v1/query',
                 '/prometheus/metrics', '/prometheus/federate', '/prometheus/-/reload',
                 '/prometheus/api/v1/admin/tsdb/delete_series', '/internal/metrics', '/metrics', '/.env']:
        request(path, [404])
    for path in ['//grafana/api/user', '/%67rafana/api/user', '/grafana%2fapi/user',
                 '/grafana//api/user', '/%70rometheus/api/v1/query', '/prometheus%2fapi/v1/query']:
        request(path, [401])
    for prefix in ['grafana', 'prometheus', 'monitoring']:
        r, _ = request('/' + prefix, [308], 'administrator')
        assert r.getheader('Location') == f'https://{HOST}/{prefix}/'
    request('/prometheus/', [401], 'stakeholder')
    request('/prometheus/api/v1/query?query=up', [401], 'stakeholder')
    request('/prometheus/api/v1/query?query=up', [200], 'administrator')
    request('/prometheus/api/v1/targets', [200], 'administrator')
    request('/prometheus/api/v1/status/runtimeinfo', [200], 'administrator')
    request('/prometheus/api/v1/query', [403], 'administrator', 'POST', {'query': 'up'})
    request('/grafana/api/user', [401], 'stakeholder')
    for role in credentials:
        request('/grafana/login', [200], role)
        request('/monitoring/', [200], role)
    r, data = request('/api/health', [200]); assert json.loads(data) == {'status': 'ok'}
    request('/', [200])
    result = {'result': 'PASS', 'at': time.time(), 'execution': 'VPS through public HTTPS DNS; external Chromium verified separately',
              'checks': checks, 'count': len(checks), 'tls_verification': True}
    (Q / 'access-security.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({k: v for k, v in result.items() if k != 'checks'}))


if __name__ == '__main__':
    main()
