#!/usr/bin/env python3
"""Restart ONLY a disposable rehearsal app; verify all pre-restart rows/files."""
import argparse
import importlib.util
import json
from pathlib import Path
import subprocess
import time
import urllib.request

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--work',type=Path,required=True)
p.add_argument('--env-file',type=Path,required=True)
p.add_argument('--port',type=int,default=18000)
a=p.parse_args()
root=Path(__file__).resolve().parents[1]
from dotenv import dotenv_values
env=dotenv_values(a.env_file)
data=(a.work/'data').resolve()
if str(data) != str(Path(env['APP_DATA_DIR']).resolve()) or data.is_relative_to(Path('/var/lib/helix')):
    p.error('Only the explicitly prepared disposable work/data path is allowed')
if not (a.work/'app.env').is_file() or not (a.work/'rehearsal-approved').is_file():
    p.error('Prepared work/app.env and a rehearsal-approved marker are required')
spec=importlib.util.spec_from_file_location('safety',root/'scripts/data-safety.py')
safety=importlib.util.module_from_spec(spec);spec.loader.exec_module(safety)
backup=a.work/('restart-baseline-'+str(time.time_ns()))
safety.snapshot(data,a.work/'app.env',backup,None)
compose=['docker','compose','--env-file',str(a.env_file.resolve()),'-f',str(root/'compose.yaml')]
subprocess.run(compose+['restart','app'],check=True)
for _ in range(60):
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{a.port}/api/health',timeout=2) as response:
            if response.status==200: break
    except OSError: pass
    time.sleep(1)
else: raise RuntimeError('Rehearsal app did not recover')
safety.compare(backup/'smooth.db',data/'smooth.db')
current=safety.manifest(data/'uploads')
for name,digest in safety.manifest(backup/'uploads').items():
    if current.get(name)!=digest: raise RuntimeError('Persistent upload changed or disappeared')
print('Rehearsal restart preserved every baseline row and upload byte.')
