#!/usr/bin/env python3
"""Run previous systemd code on a SECOND copy of candidate data, never live data."""
import argparse
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
from dotenv import dotenv_values

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--candidate-data',type=Path,required=True)
p.add_argument('--candidate-env',type=Path,required=True)
p.add_argument('--old-release',type=Path,required=True)
p.add_argument('--output',type=Path,required=True)
a=p.parse_args()
if a.candidate_data.resolve().is_relative_to(Path('/var/lib/helix')):
    p.error('Use disposable rehearsal data only')
if not (a.old_release/'.helix-build.json').is_file(): p.error('Retained sealed old release required')
a.output.mkdir(parents=True,mode=0o700,exist_ok=False)
root=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('safety',root/'scripts/data-safety.py')
safety=importlib.util.module_from_spec(spec);spec.loader.exec_module(safety)
safety.snapshot(a.candidate_data,a.candidate_env,a.output/'baseline',None)
work=a.output/'work';shutil.copytree(a.output/'baseline',work)
env={**os.environ,**dict(dotenv_values(a.candidate_env)),
     'DATABASE_URL':'sqlite:///'+str(work.resolve()/'smooth.db'),
     'UPLOAD_DIR':str(work.resolve()/'uploads'),'FRONTEND_DIST_DIR':''}
env.pop('METRICS_TOKEN_FILE',None)
code='import asyncio\nfrom app.main import app, lifespan\nasync def check():\n async with lifespan(app): pass\nasyncio.run(check())'
for _ in range(2):
    subprocess.run([str(a.old_release/'.venv/bin/python'),'-c',code],cwd=a.old_release/'smooth/backend',env=env,check=True,timeout=120)
safety.compare(a.output/'baseline/smooth.db',work/'smooth.db')
if safety.manifest(a.output/'baseline/uploads')!=safety.manifest(work/'uploads'):
    raise RuntimeError('Old-code startup changed copied uploads; review rollback compatibility')
print('Previous runtime startup twice preserved candidate-copy rows and uploads. Actual systemd rollback remains a separate live gate.')
