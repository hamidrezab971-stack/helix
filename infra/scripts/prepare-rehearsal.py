#!/usr/bin/env python3
"""Make a disposable second copy and a Compose raw environment, preserving keys."""
import argparse
import os
from pathlib import Path
import shutil
from dotenv import dotenv_values

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--baseline',type=Path,required=True)
p.add_argument('--output',type=Path,required=True)
p.add_argument('--origin',default='http://127.0.0.1:18000')
a=p.parse_args()
if not (a.baseline/'snapshot.json').is_file(): p.error('Verified baseline snapshot required')
if a.output.resolve().is_relative_to(a.baseline.resolve()): p.error('Work directory must be outside the retained baseline')
os.umask(0o077)
a.output.mkdir(mode=0o700,parents=True,exist_ok=False)
(a.output/'data').mkdir()
shutil.copyfile(a.baseline/'smooth.db',a.output/'data/smooth.db')
shutil.copytree(a.baseline/'uploads',a.output/'data/uploads')
env=dict(dotenv_values(a.baseline/'app.env'))
if not env.get('SECRET_KEY') or len(env['SECRET_KEY'].encode()) < 32: p.error('Existing application signing key required')
env.update(DATABASE_URL='sqlite:////data/smooth.db',UPLOAD_DIR='/data/uploads',FRONTEND_ORIGIN=a.origin)
env.pop('FRONTEND_DIST_DIR',None)
with (a.output/'app.env').open('x') as f:
    for k,v in env.items():
        if v is None or '\n' in v or '\r' in v: p.error('Environment values must be single line strings')
        f.write(k+'='+v+'\n')
print('Disposable data and raw Compose environment created; signing keys preserved. Set ownership on this copy only.')
