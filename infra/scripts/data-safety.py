#!/usr/bin/env python3
"""Verified copies and row-level continuity checks; no restore operation exists."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess


def connect(path):
    if not path.is_file() or path.stat().st_size == 0:
        raise RuntimeError('Existing nonempty database required')
    return sqlite3.connect(path.resolve().as_uri()+'?mode=ro',uri=True)


def integrity(db):
    if db.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
        raise RuntimeError('SQLite integrity_check failed; values withheld')
    if db.execute('PRAGMA foreign_key_check').fetchone():
        raise RuntimeError('SQLite foreign_key_check failed; values withheld')


def manifest(root):
    if not root.is_dir() or root.is_symlink(): raise RuntimeError('Real uploads directory required')
    result={}
    for path in sorted(root.rglob('*')):
        if path.is_symlink(): raise RuntimeError('Symlink found in uploads; review required')
        if path.is_file():
            with path.open('rb') as f: result[str(path.relative_to(root))]=hashlib.file_digest(f,'sha256').hexdigest()
        elif not path.is_dir(): raise RuntimeError('Special file found in uploads')
    return result


def quote(name): return '"'+name.replace('"','""')+'"'


def compare(before, after):
    with connect(before) as baseline, connect(after) as candidate:
        integrity(baseline); integrity(candidate)
        candidate.execute('ATTACH DATABASE ? AS baseline',(before.resolve().as_uri()+'?mode=ro',))
        tables=[r[0] for r in baseline.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
        result={}
        for table in tables:
            cols=[r[1] for r in baseline.execute('PRAGMA table_info('+quote(table)+')')]
            columns=','.join(map(quote,cols))
            missing=candidate.execute(f'SELECT {columns} FROM baseline.{quote(table)} EXCEPT SELECT {columns} FROM main.{quote(table)} LIMIT 1').fetchone()
            if missing is not None: raise RuntimeError('Existing row changed or lost in '+table+'; values withheld')
            result[table]=baseline.execute('SELECT count(*) FROM '+quote(table)).fetchone()[0]
    return result


def snapshot(data, env, output, unit):
    data=data.resolve()
    if data == Path('/var/lib/helix') and unit != 'helix.service':
        raise RuntimeError('Production snapshot requires --inactive-unit helix.service during authorized maintenance')
    if unit:
        state=subprocess.check_output(['systemctl','show',unit,'-p','ActiveState','--value'],text=True).strip()
        if state != 'inactive': raise RuntimeError('Writer must be inactive before a cutover snapshot')
    os.umask(0o077)
    output.mkdir(mode=0o700,parents=True,exist_ok=False)
    before=manifest(data/'uploads')
    shutil.copytree(data/'uploads',output/'uploads')
    with connect(data/'smooth.db') as source:
        integrity(source)
        with sqlite3.connect(output/'smooth.db') as destination:
            source.backup(destination)
            integrity(destination)
    if before != manifest(output/'uploads') or before != manifest(data/'uploads'):
        raise RuntimeError('Uploads changed during snapshot; discard this incomplete copy and retry')
    if env.is_symlink() or not env.is_file(): raise RuntimeError('Regular private environment file required')
    env_digest=hashlib.sha256(env.read_bytes()).hexdigest()
    shutil.copyfile(env,output/'app.env'); os.chmod(output/'app.env',0o600)
    if hashlib.sha256((output/'app.env').read_bytes()).hexdigest()!=env_digest or hashlib.sha256(env.read_bytes()).hexdigest()!=env_digest:
        raise RuntimeError('Persistent environment changed during snapshot; retry after review')
    (output/'uploads-manifest.json').write_text(json.dumps(before,indent=2)+'\n')
    rows=compare(data/'smooth.db',output/'smooth.db')
    for path in output.rglob('*'):
        if path.is_file():
            with path.open('rb') as f: os.fsync(f.fileno())
    report={'verified':True,'source':str(data),'inactive_unit':unit,'tables':rows,'upload_files':len(before),'environment_sha256':env_digest}
    (output/'snapshot.json').write_text(json.dumps(report,indent=2)+'\n')
    with (output/'snapshot.json').open('rb') as f: os.fsync(f.fileno())
    for directory in sorted((x for x in output.rglob('*') if x.is_dir()),reverse=True):
        fd=os.open(directory,os.O_DIRECTORY); os.fsync(fd); os.close(fd)
    fd=os.open(output,os.O_DIRECTORY); os.fsync(fd); os.close(fd)
    print('Verified private snapshot created. Preserve this baseline; rehearse on a second copy.')


def main():
    p=argparse.ArgumentParser(description=__doc__)
    sub=p.add_subparsers(dest='command',required=True)
    s=sub.add_parser('snapshot'); s.add_argument('--data',type=Path,required=True); s.add_argument('--env',type=Path,required=True); s.add_argument('--output',type=Path,required=True); s.add_argument('--inactive-unit')
    c=sub.add_parser('compare'); c.add_argument('before',type=Path); c.add_argument('after',type=Path)
    a=p.parse_args()
    if a.command=='snapshot': snapshot(a.data,a.env,a.output,a.inactive_unit)
    else: print(json.dumps({'preserved_tables':compare(a.before,a.after)},indent=2))

if __name__=='__main__': main()
