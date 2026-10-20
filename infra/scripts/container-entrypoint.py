"""Fail before application migrations when the audited persistent DB is absent."""
import os
from pathlib import Path
import sqlite3

os.umask(0o077)
url = os.environ['DATABASE_URL']
if not url.startswith('sqlite:////') or '?' in url:
    raise SystemExit('An absolute persistent SQLite database path is required.')
database = Path(url[len('sqlite:///'):])
uploads = Path(os.environ['UPLOAD_DIR'])
if not database.is_file() or database.stat().st_size == 0 or not uploads.is_dir():
    raise SystemExit('Existing database and uploads directory required; refusing empty initialization.')
with sqlite3.connect(database.as_uri()+'?mode=ro', uri=True) as db:
    if db.execute('PRAGMA quick_check').fetchall() != [('ok',)]:
        raise SystemExit('SQLite quick_check failed.')
    if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'").fetchone():
        raise SystemExit('Existing HELIX schema required.')
if not os.access(database, os.W_OK) or not os.access(database.parent, os.W_OK) or not os.access(uploads, os.W_OK):
    raise SystemExit('Persistent data is not writable by the configured runtime identity.')
if os.geteuid() == 0 or os.getegid() == 0:
    raise SystemExit('A non-root runtime UID and GID are required.')
os.execvp('python', ['python','-m','uvicorn','app.main:app','--host','0.0.0.0',
    '--port','8000','--workers','1','--ws','wsproto', '--no-access-log',
    '--proxy-headers','--forwarded-allow-ips',os.getenv('FORWARDED_ALLOW_IPS','127.0.0.1')])
