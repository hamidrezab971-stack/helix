#!/usr/bin/env python3
"""Build and verify a disposable real Docker/Nginx stack; never cut over production."""
import argparse
import os
from pathlib import Path
import re
import subprocess
import time
import urllib.request
from dotenv import dotenv_values

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--env-file',type=Path,required=True)
p.add_argument('--work',type=Path,required=True)
a=p.parse_args()
root=Path(__file__).resolve().parents[1]
env=dotenv_values(a.env_file)
project=env.get('COMPOSE_PROJECT_NAME','')
if not re.fullmatch(r'helix212-rehearsal-[a-z0-9-]+',project): p.error('A unique helix212-rehearsal-* project is required')
if int(env['APP_UID']) <= 0 or int(env['APP_GID']) <= 0: p.error('A non-root UID and GID are required')
work=a.work.resolve(); data=(work/'data').resolve()
if Path(env['APP_DATA_DIR']).resolve()!=data or data.is_relative_to(Path('/var/lib/helix')):
    p.error('Compose must use work/data outside production storage')
if str(work) in ('/','/var','/root') or not (work/'app.env').is_file(): p.error('Prepared disposable work required')
if env.get('APP_PORT','18000')!='18000' or env.get('GRAFANA_PORT','13000')!='13000': p.error('Rehearsal proxy ports must match the reviewed config')
for key in ('NODE_IMAGE','PYTHON_IMAGE','PROMETHEUS_IMAGE','GRAFANA_IMAGE','NODE_EXPORTER_IMAGE'):
    if not re.fullmatch(r'[^\s]+@sha256:[0-9a-f]{64}',env.get(key,'')): p.error(key+' must be digest-pinned')
appenv=dotenv_values(env['APP_ENV_FILE'])
if appenv.get('FRONTEND_ORIGIN')!='http://127.0.0.1:18443': p.error('Rehearsal origin must match isolated Nginx')
if Path(env['APP_ENV_FILE']).resolve()!=work/'app.env': p.error('Use the prepared private work/app.env')
for target in (data,data/'smooth.db',data/'uploads'):
    if target.stat().st_uid!=int(env['APP_UID']) or target.stat().st_gid!=int(env['APP_GID']):
        p.error('Disposable data ownership must match the runtime UID/GID')
(work/'rehearsal-approved').touch(mode=0o600)
compose=['docker','compose','--env-file',str(a.env_file.resolve()),'-f',str(root/'compose.yaml')]
def run(args,**kwargs): subprocess.run(list(map(str,args)),check=True,**kwargs)
run(compose+['config','--quiet'])
run(compose+['build','--pull','app'])
run(compose+['up','-d','--wait','--wait-timeout','90'])
run(compose+['exec','-T','prometheus','promtool','check','config','/etc/prometheus/prometheus.yml'])
run(compose+['exec','-T','prometheus','promtool','check','rules','/etc/prometheus/alerts.yml'])
nginx=work/'nginx'; nginx.mkdir(exist_ok=True)
nginx_args=['nginx','-p',str(nginx)+'/', '-c',str(root/'nginx/rehearsal.conf')]
run(nginx_args+['-t']);run(nginx_args)
try:
    from PIL import Image
    image=work/'qa.png';Image.new('RGB',(64,64),'coral').save(image,'PNG')
    browser_env={**os.environ,'HELIX_DISPOSABLE_DATA':'yes','HELIX_REHEARSAL_ORIGIN':'http://127.0.0.1:18443','HELIX_QA_IMAGE':str(image)}
    run(['node',root/'scripts/smoke-browser.cjs'],env=browser_env)
    run([os.sys.executable,root/'scripts/host-collector.py','--project',project,'--directory',env['TEXTFILE_DIR']])
    # Two actual scrapes are necessary for rate panels. No fake time series.
    for _ in range(35): time.sleep(1)
    run([os.sys.executable,root/'scripts/verify-stack.py','--env-file',a.env_file,
        '--metrics-token-file',env['METRICS_TOKEN_FILE'],'--grafana-password-file',env['GRAFANA_PASSWORD_FILE'],
        '--public-origin','http://127.0.0.1:18443','--require-observations'])
    run([os.sys.executable,root/'scripts/verify-persistence.py','--env-file',a.env_file,'--work',work])
finally:
    subprocess.run(nginx_args+['-s','quit'],check=False)
print('Rehearsal completed. Compose remains available on loopback for inspection; production was not selected or stopped.')
