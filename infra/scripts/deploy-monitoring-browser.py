#!/usr/bin/env python3
"""Guarded Phase 21.3 activation. No application recreation or image builds.

Secrets enter memory from protected files only; no response bodies are logged.
The rollback is immutable and outside Git. --rollback closes the new routes
before restoring Prometheus. A failed activation also invokes this rollback.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
LIVE = Path('/opt/helix-docker-production/infra')
SITE = Path('/etc/nginx/sites-available/helix.localip.ir.conf')
Q = Path('/root/helix-phase21.3')
BACK = Q / 'rollback'
HANDOFF = Path('/etc/helix/monitoring-handoff')
ENV = Path('/etc/helix/docker-compose.env')
PIN = 'sha256:1386cfea0081497a6608e5947f208bf7d8e91cd180293eab75d01dd69b75a5d9'


def atomic(path, content, mode=0o644, gid=0):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix='.helix-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(content); stream.flush(); os.fsync(stream.fileno())
        os.chmod(tmp, mode); os.chown(tmp, 0, gid); os.replace(tmp, path)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)


def inspect(name):
    return json.loads(subprocess.check_output(['docker', 'inspect', name], timeout=20))[0]


def grafana(path, method='GET', payload=None):
    password = Path('/etc/helix/docker-secrets/grafana_password').read_text().strip()
    headers = {'Host': 'helix.localip.ir', 'Authorization': 'Basic ' + base64.b64encode(
        ('helix-admin:' + password).encode()).decode(), 'Content-Type': 'application/json'}
    req = urllib.request.Request('http://127.0.0.1:13000/grafana' + path,
        data=json.dumps(payload).encode() if payload is not None else None, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=20) as response:
        return json.load(response)


def compose(overlay=True):
    cmd = ['docker', 'compose', '--env-file', str(ENV), '-f', str(LIVE / 'compose.yaml')]
    if overlay: cmd += ['-f', str(LIVE / 'compose.monitoring-subpaths.yaml')]
    return cmd


def recreate_prometheus(overlay):
    subprocess.run(compose(overlay) + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never',
        '--wait', '--wait-timeout', '120', 'prometheus'], check=True, timeout=150)


def reload_nginx(expected_status):
    subprocess.run(['nginx', '-t'], check=True)
    subprocess.run(['systemctl', 'reload', 'nginx'], check=True)
    # Reload acknowledgement precedes new workers accepting connections. Verify
    # three fresh TLS connections before testing the new generation; 200 always
    # fails immediately. Do not accept the previous ACL's 403 as public delivery.
    stable = 0
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for _ in range(75):
        request = urllib.request.Request('https://helix.localip.ir/grafana/api/health',
                                         headers={'Connection': 'close'})
        try:
            with opener.open(request, timeout=5) as response: status = response.status
        except urllib.error.HTTPError as error: status = error.code
        assert status in (401, 403), 'Unexpected anonymous monitoring response during reload'
        stable = stable + 1 if status == expected_status else 0
        if stable == 3: return
        time.sleep(.2)
    raise RuntimeError('Nginx worker generation did not converge to the protected policy')


def save_rollback(paths):
    if BACK.exists():
        assert (Q / 'exposure-rolled-back.json').exists(), 'Existing activation must be reviewed first'
        manifest = json.loads((BACK / 'manifest.json').read_text())
        original = next(row for row in manifest if row['path'] == str(SITE))
        assert SITE.read_bytes() == Path(original['copy']).read_bytes(), 'Production site changed after rollback'
        return
    BACK.mkdir(mode=0o700)
    manifest = []
    for i, p in enumerate(paths):
        item = {'path': str(p), 'exists': p.exists()}
        if p.exists():
            s = p.stat(); copy = BACK / str(i); shutil.copy2(p, copy)
            item.update(copy=str(copy), mode=s.st_mode & 0o777, gid=s.st_gid)
        manifest.append(item)
    (BACK / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')


def rollback():
    manifest = json.loads((BACK / 'manifest.json').read_text())
    # Site first: the previous localhost-only proxy closes external exposure.
    site = next(row for row in manifest if row['path'] == str(SITE))
    atomic(SITE, Path(site['copy']).read_bytes(), site['mode'], site['gid'])
    for row in manifest:
        p = Path(row['path'])
        if p == SITE: continue
        if row['exists']: atomic(p, Path(row['copy']).read_bytes(), row['mode'], row['gid'])
        elif p.exists(): p.unlink()
    reload_nginx(403)
    recreate_prometheus(False)
    subprocess.run(['systemctl', 'restart', 'systemd-journald'], check=True)
    (Q / 'exposure-rolled-back.json').write_text(json.dumps({'at': time.time(), 'closed': True}) + '\n')


def provision():
    import secrets
    import warnings
    with warnings.catch_warnings():
        warnings.simplefilter('ignore', DeprecationWarning)
        import crypt
    HANDOFF.mkdir(mode=0o700, exist_ok=True)
    specs = {'administrator': ('monitoring-admin', 'helix-admin'),
             'stakeholder': ('stakeholder-viewer', 'helix-stakeholder')}
    credentials = {}
    for role, (edge_user, native_user) in specs.items():
        p = HANDOFF / (role + '.json')
        if p.exists(): value = json.loads(p.read_text())
        else:
            value = {'edge': {'username': edge_user, 'password': secrets.token_urlsafe(32)},
                     'grafana': {'username': native_user, 'password':
                        Path('/etc/helix/docker-secrets/grafana_password').read_text().strip()
                        if role == 'administrator' else secrets.token_urlsafe(32)}}
            atomic(p, (json.dumps(value, indent=2) + '\n').encode(), 0o600)
        credentials[role] = value
    users = grafana('/api/users')
    viewer = next((x for x in users if x['login'] == 'helix-stakeholder'), None)
    if viewer is None:
        g = credentials['stakeholder']['grafana']
        created = grafana('/api/admin/users', 'POST', {'name': 'HELIX Stakeholder',
            'login': g['username'], 'password': g['password'], 'OrgId': 1})
        viewer_id = created['id']
    else:
        viewer_id = viewer['id']
        assert not viewer['isAdmin'], 'Existing stakeholder is an administrator; stop'
    grafana('/api/org/users/' + str(viewer_id), 'PATCH', {'role': 'Viewer'})
    actual = next(x for x in grafana('/api/org/users') if x['userId'] == viewer_id)
    assert actual['role'] == 'Viewer'
    hashes = {}
    for role, value in credentials.items():
        edge = value['edge']; salt = crypt.mksalt(crypt.METHOD_SHA512, rounds=100000)
        hashes[role] = edge['username'] + ':' + crypt.crypt(edge['password'], salt) + '\n'
    atomic(Path('/etc/nginx/helix-monitoring.htpasswd'), ''.join(hashes.values()).encode(), 0o640, 33)
    atomic(Path('/etc/nginx/helix-monitoring-admin.htpasswd'), hashes['administrator'].encode(), 0o640, 33)
    return {'viewer_id': viewer_id, 'viewer_role': 'Viewer', 'native_admin': 'helix-admin',
            'credentials_directory': str(HANDOFF), 'handoff': 'root-only; operator delivers stakeholder.json over a trusted channel'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--rollback', action='store_true')
    args = parser.parse_args()
    assert os.geteuid() == 0
    os.umask(0o077)
    if args.rollback: rollback(); return
    graf = inspect('helix-production-grafana-1')
    app = inspect('helix-production-app')
    node = inspect('helix-production-node-exporter-1')
    assert graf['Image'] == PIN and graf['State']['Health']['Status'] == 'healthy'
    current_env = dict(x.split('=', 1) for x in graf['Config']['Env'])
    for key, value in {'GF_AUTH_ANONYMOUS_ENABLED': 'false', 'GF_USERS_ALLOW_SIGN_UP': 'false',
        'GF_SERVER_ROOT_URL': 'https://helix.localip.ir/grafana/', 'GF_SERVER_SERVE_FROM_SUB_PATH': 'true',
        'GF_SECURITY_COOKIE_SECURE': 'true', 'GF_SECURITY_COOKIE_SAMESITE': 'lax'}.items():
        assert current_env.get(key) == value, key + ' differs from reviewed settings'
    assert json.loads(urllib.request.urlopen('https://helix.localip.ir/api/health', timeout=10).read()) == {'status': 'ok'}
    old_site = SITE.read_text()
    start = old_site.index('    # Fail closed until the independent Grafana security gate')
    end = old_site.index('    location = /internal', start)
    routes = (ROOT / 'infra/nginx/monitoring-routes.conf.example').read_text()
    new_site = old_site[:start] + '\n'.join('    ' + line for line in routes.splitlines()) + '\n' + old_site[end:]
    snippets = {Path('/etc/nginx/snippets/helix-' + name + '.conf'):
        ROOT / ('infra/nginx/' + name + '.conf.example')
        for name in ['monitoring-access', 'monitoring-admin-access']}
    snippets[Path('/etc/nginx/conf.d/helix-monitoring-http.conf')] = ROOT / 'infra/nginx/monitoring-http.conf.example'
    files = [SITE, *snippets, Path('/etc/nginx/helix-monitoring.htpasswd'),
        Path('/etc/nginx/helix-monitoring-admin.htpasswd'), LIVE / 'compose.monitoring-subpaths.yaml',
        LIVE / 'prometheus/alerts.yml', Path('/var/www/helix-monitoring/index.html'),
        Path('/etc/systemd/journald.conf.d/helix-retention.conf')]
    save_rollback(files)
    try:
        access = provision()
        for target, source in snippets.items(): atomic(target, source.read_bytes())
        atomic(LIVE / 'compose.monitoring-subpaths.yaml', (ROOT / 'infra/compose.monitoring-subpaths.yaml').read_bytes())
        atomic(LIVE / 'prometheus/alerts.yml', (ROOT / 'infra/prometheus/alerts.yml').read_bytes())
        subprocess.run(['docker', 'exec', 'helix-production-prometheus-1', 'promtool', 'check',
            'config', '/etc/prometheus/prometheus.yml'], check=True, timeout=20)
        recreate_prometheus(True)
        public_dir = Path('/var/www/helix-monitoring')
        public_dir.mkdir(exist_ok=True)
        public_dir.chmod(0o755)
        atomic(public_dir / 'index.html', (ROOT / 'infra/nginx/monitoring-index.html').read_bytes())
        atomic(SITE, new_site.encode())
        reload_nginx(401)
        subprocess.run(['python3', str(ROOT / 'infra/scripts/verify-monitoring-access.py')], check=True, timeout=120)
        for name, original in [('helix-production-app', app), ('helix-production-node-exporter-1', node),
                                ('helix-production-grafana-1', graf)]:
            now = inspect(name)
            assert now['Id'] == original['Id'] and now['Image'] == original['Image'] and now['Mounts'] == original['Mounts']
            assert now['State']['Health']['Status'] == 'healthy'
        journal_dir = Path('/etc/systemd/journald.conf.d')
        journal_dir.mkdir(exist_ok=True)
        journal_dir.chmod(0o755)
        atomic(journal_dir / 'helix-retention.conf',
            (ROOT / 'infra/systemd/helix-journald-retention.conf').read_bytes())
        subprocess.run(['systemctl', 'restart', 'systemd-journald'], check=True)
        (Q / 'deployment.json').write_text(json.dumps({'at': time.time(), 'grafana_image': PIN,
            'application_container_unchanged': True, 'node_container_unchanged': True,
            'grafana_container_unchanged': True, 'prometheus_recreated_only': True,
            'access': access, 'nginx_sha256': hashlib.sha256(SITE.read_bytes()).hexdigest(),
            'git_commit_at_activation': subprocess.check_output(['git', '-C', ROOT, 'rev-parse', 'HEAD'], text=True).strip()}, indent=2) + '\n')
        print('Protected browser routes activated; application, exporter and Grafana containers unchanged.')
    except Exception:
        rollback()
        raise RuntimeError('Activation failed and new exposure was reverted; sensitive details withheld') from None


if __name__ == '__main__':
    main()
