"""Guard persistent storage; initialize a fresh database only by explicit command."""
import asyncio
import fcntl
import os
from pathlib import Path
import sqlite3
import stat
import sys

os.umask(0o077)
url = os.environ['DATABASE_URL']
if not url.startswith('sqlite:////') or '?' in url:
    raise SystemExit('An absolute persistent SQLite database path is required.')
database = Path(url[len('sqlite:///'):])
uploads = Path(os.environ['UPLOAD_DIR'])
marker = database.parent / '.helix-fresh-bootstrap-v1'
if (database.is_symlink() or uploads.is_symlink()
        or database.parent.resolve() != database.parent):
    raise SystemExit('Persistent database and uploads must not be symbolic links.')


def writer_lock():
    # The inherited descriptor keeps the lock for the entire Uvicorn lifetime.
    path = database.parent / '.helix-writer.lock'
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_nlink != 1:
        os.close(fd)
        raise SystemExit('Unsafe persistent writer lock.')
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(fd)
        raise SystemExit('Another HELIX writer or bootstrap owns this storage.') from None
    os.set_inheritable(fd, True)
    return fd


def bootstrap():
    if os.geteuid() == 0 or os.getegid() == 0:
        raise SystemExit('A non-root runtime UID and GID are required.')
    if (uploads.parent != database.parent
            or not uploads.is_dir() or not database.parent.is_dir()
            or database.exists() or marker.exists() or marker.is_symlink()
            or list(uploads.iterdir())):
        raise SystemExit('Fresh bootstrap requires absent database and empty uploads; existing data is never overwritten.')
    fd = writer_lock()
    allowed = {uploads.name, '.helix-writer.lock'}
    if any(p.name not in allowed for p in database.parent.iterdir()):
        raise SystemExit('Fresh bootstrap requires a dedicated empty storage directory.')
    # O_EXCL prevents even an accidental second invocation from replacing data.
    with database.open('xb'):
        pass
    sys.path.insert(0, str(Path.cwd()))
    from app.main import app, lifespan

    async def initialize():
        async with lifespan(app):
            pass

    asyncio.run(initialize())
    with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True) as db:
        if db.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
            raise SystemExit('Fresh database integrity_check failed.')
        if db.execute('PRAGMA foreign_key_check').fetchone():
            raise SystemExit('Fresh database foreign_key_check failed.')
        for table in ('users', 'conversations', 'messages'):
            if db.execute('SELECT count(*) FROM ' + table).fetchone()[0]:
                raise SystemExit('Fresh bootstrap unexpectedly created application records.')
    if list(uploads.iterdir()):
        raise SystemExit('Fresh bootstrap unexpectedly created uploaded files.')
    # A failed bootstrap has no completion marker and cannot start an empty app.
    with database.open('rb') as out:
        os.fsync(out.fileno())
    with marker.open('xb') as out:
        out.write(b'HELIX fresh bootstrap v1\n'); out.flush(); os.fsync(out.fileno())
    directory = os.open(database.parent, os.O_DIRECTORY)
    os.fsync(directory); os.close(directory); os.close(fd)
    print('Fresh database initialized through the application lifespan; integrity/FK OK; zero users, conversations and messages.')


if sys.argv[1:] == ['--initialize-empty']:
    bootstrap()
    raise SystemExit(0)
if sys.argv[1:]:
    raise SystemExit('Supported command: --initialize-empty, or no arguments for normal startup.')
if not database.is_file() or database.stat().st_size == 0 or not uploads.is_dir():
    raise SystemExit('Existing database and uploads directory required; refusing empty initialization.')
with sqlite3.connect(database.as_uri()+'?mode=ro', uri=True) as db:
    if db.execute('PRAGMA quick_check').fetchall() != [('ok',)]:
        raise SystemExit('SQLite quick_check failed.')
    if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'").fetchone():
        raise SystemExit('Existing HELIX schema required.')
    columns = {row[1] for row in db.execute('PRAGMA table_info(users)')}
    if not {'id', 'username', 'password_hash'} <= columns:
        raise SystemExit('Existing HELIX account schema required.')
    if not db.execute('SELECT 1 FROM users LIMIT 1').fetchone():
        if (marker.is_symlink() or not marker.is_file()
                or marker.stat().st_uid != database.stat().st_uid
                or marker.stat().st_mode & 0o077
                or marker.read_bytes() != b'HELIX fresh bootstrap v1\n'):
            raise SystemExit('Explicit fresh bootstrap required; refusing empty initialization.')
    if db.execute('PRAGMA foreign_key_check').fetchone():
        raise SystemExit('SQLite foreign_key_check failed; values withheld.')
if not os.access(database, os.W_OK) or not os.access(database.parent, os.W_OK) or not os.access(uploads, os.W_OK):
    raise SystemExit('Persistent data is not writable by the configured runtime identity.')
if os.geteuid() == 0 or os.getegid() == 0:
    raise SystemExit('A non-root runtime UID and GID are required.')
writer_fd = writer_lock()
os.execvp('python', ['python','-m','uvicorn','app.main:app','--host','0.0.0.0',
    '--port','8000','--workers','1','--ws','wsproto', '--no-access-log',
    '--proxy-headers','--forwarded-allow-ips',os.getenv('FORWARDED_ALLOW_IPS','127.0.0.1')])
