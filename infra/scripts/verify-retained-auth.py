#!/usr/bin/env python3
"""Existing-account CAPTCHA/login on an isolated candidate; no account writes."""
import argparse
import fcntl
import getpass
import hashlib
import hmac
import json
import os
from pathlib import Path
import resource
import sqlite3
import stat
import subprocess
import sys
import time
import urllib.request
import warnings
from dotenv import dotenv_values
import jwt


def require(value, message):
    if not value:
        raise RuntimeError(message)


def accounts(path):
    require(path.is_file() and not path.is_symlink(), 'Existing regular candidate DB required')
    with sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True) as db:
        return {r[0]: (r[1], r[2]) for r in db.execute('SELECT id,username,password_hash FROM users')}


def credential(fd):
    seals = fcntl.F_SEAL_SEAL | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_GROW | fcntl.F_SEAL_WRITE
    require(fd > 2 and fcntl.fcntl(fd, fcntl.F_GET_SEALS) & seals == seals,
            'A dedicated sealed credential descriptor is required')
    info = os.fstat(fd)
    require(stat.S_ISREG(info.st_mode) and info.st_uid == 0
            and stat.S_IMODE(info.st_mode) == 0o600 and info.st_size <= 4096,
            'Unsafe credential descriptor')
    value = json.loads(os.pread(fd, 4097, 0))
    require(isinstance(value, dict) and set(value) == {'username', 'password', 'created_at'}
            and isinstance(value['created_at'], (int, float))
            and 0 <= time.time() - value['created_at'] < 7200,
            'Credential expired or malformed; values withheld')
    return value['username'], value['password']


def hidden_input():
    require(sys.stdin.isatty(), 'Hidden input requires an interactive terminal')
    with warnings.catch_warnings():
        warnings.simplefilter('error', getpass.GetPassWarning)
        username = getpass.getpass('Existing account username (hidden): ')
        password = getpass.getpass('Existing account password (hidden): ')
    return username, password


def captcha_key(env):
    return env.get('CAPTCHA_KEY') or hmac.new(env['SECRET_KEY'].encode(),
                                            b'helix/altcha/v20', hashlib.sha256).hexdigest()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--baseline', type=Path, required=True)
    p.add_argument('--env-file', type=Path, required=True, help='Private rehearsal Compose env')
    p.add_argument('--origin', default='http://127.0.0.1:18443',
                   choices=('http://127.0.0.1:18000', 'http://127.0.0.1:18443'))
    creds = p.add_mutually_exclusive_group(required=True)
    creds.add_argument('--credential-fd', type=int, help='Existing sealed handoff protocol')
    creds.add_argument('--hidden-input', action='store_true')
    a = p.parse_args()
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    baseline = a.baseline.resolve()
    snapshot = json.loads((baseline / 'snapshot.json').read_text())
    require(snapshot.get('verified') is True and snapshot.get('source') == '/var/lib/helix',
            'Verified real production snapshot required')
    require(0 <= time.time() - (baseline / 'snapshot.json').stat().st_mtime < 86400,
            'A production baseline less than 24 hours old is required')
    env = dotenv_values(a.env_file, interpolate=False)
    require(env.get('COMPOSE_PROJECT_NAME', '').startswith('helix212-rehearsal-'),
            'Qualification project required')
    data = Path(env['APP_DATA_DIR']).resolve()
    live = Path('/var/lib/helix').resolve()
    require(not data.is_relative_to(live) and not live.is_relative_to(data),
            'Authentication qualification must use isolated storage')
    name = env['COMPOSE_PROJECT_NAME'] + '-app'
    info = json.loads(subprocess.check_output(['docker', 'inspect', name], timeout=15))[0]
    mounts = [m for m in info['Mounts'] if m['Destination'] == '/data']
    require(info['State']['Running'] and len(mounts) == 1 and mounts[0]['Type'] == 'bind'
            and Path(mounts[0]['Source']).resolve() == data, 'Actual candidate storage differs')
    expected_image = json.loads(subprocess.check_output(
        ['docker', 'image', 'inspect', env['HELIX_IMAGE']], timeout=15))[0]['Id']
    require(info['Image'] == expected_image, 'Actual candidate image differs from selected image')
    before = accounts(data / 'smooth.db'); retained = accounts(baseline / 'smooth.db')
    require(retained and all(before.get(k) == v for k, v in retained.items()),
            'Retained accounts or hashes changed; values withheld')
    original = dotenv_values(baseline / 'app.env', interpolate=False)
    require((baseline / 'app.env').read_bytes() == Path('/etc/helix/production.env').read_bytes(),
            'Production signing configuration changed since the snapshot')
    actual = dict(item.split('=', 1) for item in info['Config']['Env'] if '=' in item)
    require(bool(original.get('SECRET_KEY')) and original['SECRET_KEY'] == actual.get('SECRET_KEY')
            and captcha_key(original) == captcha_key(actual), 'JWT/CAPTCHA signing continuity failed')

    # Credentials enter memory only after isolation, image and signing checks pass.
    username, password = credential(a.credential_fd) if a.credential_fd is not None else hidden_input()
    require(isinstance(username, str) and isinstance(password, str)
            and 1 <= len(username) <= 50 and 1 <= len(password) <= 128,
            'Credential schema invalid; values withheld')
    user = next((k for k, v in retained.items() if v[0] == username), None)
    require(user is not None, 'Account is absent from the original production baseline')

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    # A proxy or redirected login must never receive the credential or JWT.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def request(path, payload=None, token=None):
        headers = {'Origin': a.origin}
        if token: headers['Authorization'] = 'Bearer ' + token
        body = None
        if payload is not None:
            headers['Content-Type'] = 'application/json'; body = json.dumps(payload).encode()
        with opener.open(urllib.request.Request(a.origin + path, data=body,
                                                 headers=headers), timeout=30) as r:
            raw = r.read(1024 * 1024 + 1)
            require(len(raw) <= 1024 * 1024, 'Candidate response exceeded the verification limit')
            return json.loads(raw)

    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'smooth/backend'))
    from app.vendor.altcha import Challenge, Payload, solve_challenge
    challenge = Challenge.from_dict(request('/api/auth/challenge?purpose=login'))
    solution = solve_challenge(challenge, timeout=90)
    require(solution is not None, 'Real CAPTCHA proof timed out')
    response = request('/api/auth/login', {'username': username, 'password': password,
                                          'altcha': Payload(challenge, solution).to_base64()})
    password = None
    token = response['access_token']
    claims = jwt.decode(token, original['SECRET_KEY'], algorithms=['HS256'],
                        options={'require': ['sub', 'username', 'iat', 'exp']})
    require(claims['sub'] == str(user) and claims['username'] == username,
            'Retained signing or identity compatibility failed')
    require(request('/api/auth/me', token=token)['id'] == user, 'Protected identity check failed')
    require(isinstance(request('/api/conversations', token=token), list), 'Protected conversation API failed')
    require(isinstance(request('/api/users', token=token), list), 'Protected user API failed')
    after = accounts(data / 'smooth.db')
    require(before == after, 'Authentication changed account records/hashes; values withheld')
    print(json.dumps({'retained_account_login': True, 'captcha': True, 'protected_apis': True,
                      'signing_continuity': True, 'account_hashes_preserved': True,
                      'scope': 'isolated_candidate', 'image_id': info['Image']}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # HTTP/Pydantic/decoder errors may contain submitted inputs or tokens.
        print('Retained-account verification FAILED; credentials and responses withheld.', file=sys.stderr)
        if type(error) is RuntimeError:
            print(str(error), file=sys.stderr)
        raise SystemExit(1)
