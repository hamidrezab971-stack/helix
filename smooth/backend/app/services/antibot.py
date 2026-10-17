"""Local ALTCHA v2, bounded SQLite quotas and cross-worker Argon2 leases."""
import base64
from contextlib import contextmanager
import hashlib
import hmac
import ipaddress
import json
import logging
import secrets
import time

from fastapi import HTTPException
from sqlalchemy import text

from app.core.config import CAPTCHA_KEY
from app.database.database import engine
from app.vendor.altcha import create_challenge, verify_solution

TTL = 300
MAX_CHALLENGES = 20000
MAX_BUCKETS = 20000
log = logging.getLogger(__name__)


def address(request):
    # Read ASGI peer only. Production Uvicorn trusts ONLY 127.0.0.1 and
    # Nginx overwrites X-Forwarded-For. Never parse client-supplied headers here.
    host = request.client.host if request.client else 'unknown'
    try:
        ip = ipaddress.ip_address(host)
        # A /64 prevents cheap IPv6 privacy-address rotation.
        return str(ipaddress.ip_network(f'{ip}/64', strict=False)) if ip.version == 6 else str(ip)
    except ValueError:
        return 'unknown'


def digest(value):
    return hmac.new(CAPTCHA_KEY.encode(), value.encode(), hashlib.sha256).hexdigest()


@contextmanager
def atomic():
    with engine.connect() as c:
        c.exec_driver_sql('BEGIN IMMEDIATE')
        try:
            yield c
            c.commit()
        except BaseException:
            c.rollback()
            raise


def limited(retry=30):
    return HTTPException(429, 'Please wait before trying again.', headers={'Retry-After': str(max(1, int(retry)))})


def quota(scope, identity, limit, window):
    now = int(time.time())
    key = digest(scope + ':' + identity)
    denied = False
    with atomic() as c:
        c.execute(text('DELETE FROM auth_rate_buckets WHERE reset_at <= :now'), {'now': now})
        row = c.execute(text('SELECT count, reset_at FROM auth_rate_buckets WHERE key=:key'), {'key': key}).first()
        if row:
            denied = row.count >= limit
            if not denied:
                c.execute(text('UPDATE auth_rate_buckets SET count=count+1 WHERE key=:key'), {'key': key})
            retry = row.reset_at - now
        else:
            if c.scalar(text('SELECT count(*) FROM auth_rate_buckets')) >= MAX_BUCKETS:
                raise HTTPException(503, 'Verification is busy. Please try again shortly.')
            c.execute(text('INSERT INTO auth_rate_buckets(key,count,reset_at,blocked_until) VALUES (:key,1,:end,0)'), {'key': key, 'end': now+window})
            retry = window
    if denied:
        raise limited(retry)


def auth_limits(request, purpose, username):
    ip = address(request)
    quota(purpose + '-ip', ip, 20 if purpose == 'register' else 60, 900)
    if purpose == 'login':
        quota('account', username, 20, 900)
    key = digest('fail:' + purpose + ':' + ip + ':' + username)
    with engine.connect() as c:
        until = c.scalar(text('SELECT blocked_until FROM auth_rate_buckets WHERE key=:key AND reset_at>:now'), {'key': key, 'now': int(time.time())})
    if until and until > time.time():
        raise limited(until-time.time())
    return key


def outcome(key, success):
    now = int(time.time())
    with atomic() as c:
        if success:
            c.execute(text('DELETE FROM auth_rate_buckets WHERE key=:key'), {'key': key})
            return
        # auth_limits already cleaned expired buckets; enforce the cap here too.
        if c.scalar(text('SELECT count(*) FROM auth_rate_buckets')) >= MAX_BUCKETS:
            return
        c.execute(text('''INSERT INTO auth_rate_buckets(key,count,reset_at,blocked_until)
            VALUES (:key,1,:end,0) ON CONFLICT(key) DO UPDATE SET count=count+1,reset_at=:end'''), {'key':key,'end':now+900})
        count = c.scalar(text('SELECT count FROM auth_rate_buckets WHERE key=:key'), {'key':key})
        delay = min(60, 2 ** min(6, count-3)) if count >= 3 else 0
        c.execute(text('UPDATE auth_rate_buckets SET blocked_until=:until WHERE key=:key'), {'key':key,'until':now+delay})
    if count in (1, 2, 4, 8, 16):
        log.info('Authentication attempt rejected; progressive limit level=%d', count)


def issue(request, purpose):
    quota('challenge', address(request), 30, 300)
    now = int(time.time())
    challenge_id = secrets.token_hex(16)
    challenge = create_challenge('PBKDF2/SHA-256', 5000, key_prefix='00',
        expires_at=now+TTL, data={'id':challenge_id,'purpose':purpose}, hmac_secret=CAPTCHA_KEY).to_dict()
    with atomic() as c:
        c.execute(text('DELETE FROM auth_challenges WHERE expires_at<=:now'), {'now':now})
        if c.scalar(text('SELECT count(*) FROM auth_challenges')) >= MAX_CHALLENGES:
            raise HTTPException(503, 'Verification is busy. Please try again shortly.')
        c.execute(text('INSERT INTO auth_challenges(id,purpose,issued,expires_at) VALUES (:id,:purpose,:issued,:expires)'),
                  {'id':challenge_id,'purpose':purpose,'issued':json.dumps(challenge,sort_keys=True,separators=(',',':')),'expires':now+TTL})
    return challenge


def consume(payload, purpose):
    error = HTTPException(400, 'Verification expired or invalid. Please verify again.')
    try:
        if not isinstance(payload,str) or not 1 <= len(payload) <= 8192:
            raise ValueError
        parsed = json.loads(base64.b64decode(payload, validate=True))
        challenge = parsed['challenge']
        data = challenge['parameters']['data']
        challenge_id = data['id']
        if not isinstance(challenge_id,str) or len(challenge_id)!=32 or data['purpose']!=purpose:
            raise ValueError
        # Match stored parameters BEFORE any KDF; attackers cannot choose its
        # cost, algorithm, key length, or nested data to amplify server work.
        with engine.connect() as c:
            row = c.execute(text('SELECT issued,expires_at FROM auth_challenges WHERE id=:id AND purpose=:purpose'), {'id':challenge_id,'purpose':purpose}).first()
        if not row or row.expires_at <= time.time() or not hmac.compare_digest(
            row.issued, json.dumps(challenge,sort_keys=True,separators=(',',':'))):
            raise ValueError
        if not verify_solution(payload, CAPTCHA_KEY).verified:
            raise ValueError
    except (ValueError, TypeError, KeyError, AttributeError, OverflowError, RecursionError):
        raise error from None
    # A conditional DELETE is one atomic write, committed even if password
    # checking later fails. Two workers can never accept the same solution.
    with atomic() as c:
        deleted = c.execute(text('DELETE FROM auth_challenges WHERE id=:id AND purpose=:purpose AND expires_at>:now'), {'id':challenge_id,'purpose':purpose,'now':int(time.time())}).rowcount
    if deleted != 1:
        raise error


@contextmanager
def work_limit(kind):
    lease = kind + secrets.token_hex(16)[:31]
    now = int(time.time())
    with atomic() as c:
        c.execute(text('DELETE FROM auth_work_leases WHERE expires_at<=:now'), {'now':now})
        if c.scalar(text('SELECT count(*) FROM auth_work_leases WHERE id LIKE :kind'), {'kind':kind+'%'}) >= 2:
            raise HTTPException(503, 'The server is busy. Please try again shortly.', headers={'Retry-After':'3'})
        c.execute(text('INSERT INTO auth_work_leases(id,expires_at) VALUES (:id,:end)'), {'id':lease,'end':now+120})
    try:
        yield
    finally:
        with atomic() as c:
            c.execute(text('DELETE FROM auth_work_leases WHERE id=:id'), {'id':lease})


def password_work():
    return work_limit('p')


def image_work():
    return work_limit('i')
