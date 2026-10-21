#!/usr/bin/env python3
"""Export narrow Docker state/stats on host, without giving containers a socket."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import urllib.request

SERVICES=('app','prometheus','grafana','node-exporter')
def run(*args): return subprocess.check_output(args,text=True,timeout=30)
def memory(value):
    units={'B':1,'kB':1000,'KB':1000,'KiB':1024,'MB':1000**2,'MiB':1024**2,'GB':1000**3,'GiB':1024**3,'TB':1000**4,'TiB':1024**4}
    import re
    m=re.fullmatch(r'([0-9.]+)\s*([A-Za-z]+)',value.strip())
    if not m: raise ValueError('Unrecognized Docker memory unit')
    return float(m[1])*units[m[2]]

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--project',required=True)
p.add_argument('--api-port',type=int,default=18000)
p.add_argument('--directory',type=Path,required=True)
a=p.parse_args()
ids=run('docker','ps','-aq','--filter','label=com.docker.compose.project='+a.project).split()
rows={}
for cid in ids:
    fields=run('docker','inspect','--format','{{json .State}}|{{.RestartCount}}|{{.HostConfig.Memory}}|{{.HostConfig.NanoCpus}}|{{index .Config.Labels "com.docker.compose.service"}}',cid).strip().split('|')
    state,restarts,limit,cpu,service=fields
    if service not in SERVICES: continue
    if service in rows: raise SystemExit('Unexpected replica or stale container; collector refuses ambiguous state')
    state=json.loads(state)
    values={'running':int(state['Running']), 'healthy':int(state.get('Health',{}).get('Status')=='healthy'),'restart_count':int(restarts),'memory_limit_bytes':int(limit),'cpu_limit_cores':int(cpu)/1e9}
    if state['Running']:
        stats=json.loads(run('docker','stats','--no-stream','--format','{{json .}}',cid))
        values['cpu_cores']=float(stats['CPUPerc'].strip('%'))/100
        values['memory_bytes']=memory(stats['MemUsage'].split('/')[0])
    rows[service]=values
lines=[]
for name,kind in [('running','gauge'),('healthy','gauge'),('restart_count','gauge'),('memory_limit_bytes','gauge'),('cpu_limit_cores','gauge'),('cpu_cores','gauge'),('memory_bytes','gauge')]:
    metric='helix_container_'+name
    lines.extend([f'# HELP {metric} Current container {name}; restart count resets on recreation.',f'# TYPE {metric} {kind}'])
    for service in SERVICES:
        values=rows.get(service,{'running':0,'healthy':0})
        if name in values: lines.append(f'{metric}{{service="{service}"}} {values[name]}')
healthy=0
try:
    with urllib.request.urlopen(f'http://127.0.0.1:{a.api_port}/api/health',timeout=4) as r:
        healthy=int(r.status==200 and json.load(r)=={'status':'ok'})
except (OSError, ValueError): pass
lines.extend(['# HELP helix_api_health API database health HTTP result.','# TYPE helix_api_health gauge',f'helix_api_health {healthy}', '# HELP helix_host_collector_timestamp_seconds Last completed collection epoch.','# TYPE helix_host_collector_timestamp_seconds gauge',f'helix_host_collector_timestamp_seconds {time.time()}'])
fd,tmp=tempfile.mkstemp(prefix='.helix-',dir=a.directory)
try:
    with os.fdopen(fd,'w') as f: f.write('\n'.join(lines)+'\n'); f.flush(); os.fsync(f.fileno())
    os.chmod(tmp,0o644); os.replace(tmp,a.directory/'helix.prom')
finally:
    if os.path.exists(tmp): os.unlink(tmp)
