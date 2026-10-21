#!/usr/bin/env python3
"""Read-only real-host inventory. Store evidence privately, outside Git."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--output',type=Path,required=True)
a=p.parse_args()
os.umask(0o077)
a.output.mkdir(mode=0o700,parents=True,exist_ok=False)
results={}
commands={
 'services':['systemctl','show','helix','nginx','certbot.timer','-p','ActiveState','-p','SubState','-p','MainPID','-p','FragmentPath','-p','ExecStart'],
 'nginx':['nginx','-T'],
 'listeners':['ss','-lntp'],
 'docker':['docker','info','--format','{{json .}}'],
 'compose':['docker','compose','version'],
 'timers':['systemctl','list-timers','--all','--no-pager'],
 'certificate':['openssl','x509','-in','/etc/letsencrypt/live/helix.localip.ir/cert.pem','-noout','-dates','-issuer','-subject'],
 'public-health':['curl','--fail','--max-time','15','https://helix.localip.ir/api/health'],
}
for key,args in commands.items():
    try:
        r=subprocess.run(args,capture_output=True,text=True,timeout=30)
        (a.output/(key+'.txt')).write_text(r.stdout+r.stderr)
        results[key]={'returncode':r.returncode}
    except (OSError,subprocess.TimeoutExpired) as e: results[key]={'error':type(e).__name__}
results['pid1']=Path('/proc/1/comm').read_text().strip()
results['release']=str(Path('/opt/helix/current').resolve())
for name in ('/etc/systemd/system/helix.service','/etc/nginx/sites-available/helix.localip.ir.conf','/opt/helix/current/.helix-build.json'):
    try: results[name]={'sha256':hashlib.sha256(Path(name).read_bytes()).hexdigest()}
    except OSError as e: results[name]={'error':type(e).__name__}
# Do not dump Environment= or /proc/*/environ; these can contain credentials.
try:
    from dotenv import dotenv_values
    env=dotenv_values('/etc/helix/production.env')
    results['environment_keys']=sorted(env)
    results['data_configuration']={k:env.get(k) for k in ('DATABASE_URL','UPLOAD_DIR','FRONTEND_ORIGIN')}
except (ImportError,OSError): results['data_configuration']='unavailable; use project venv'
try:
    with socket.socket() as s: s.bind(('127.0.0.1',0))
    results['ipv4']='available'
except OSError: results['ipv4']='denied'
(a.output/'inventory.json').write_text(json.dumps(results,indent=2)+'\n')
print(json.dumps({'output':str(a.output),'real_host':results['pid1']=='systemd','ipv4':results['ipv4'],'checks':results['services']},indent=2))
