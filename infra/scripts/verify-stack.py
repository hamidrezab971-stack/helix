#!/usr/bin/env python3
"""Fail-closed integration verification against running, real Compose services."""
import argparse
import base64
import json
from pathlib import Path
import subprocess
import time
import urllib.parse
import urllib.request

ROOT=Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--env-file',type=Path,required=True)
p.add_argument('--metrics-token-file',type=Path,required=True)
p.add_argument('--grafana-password-file',type=Path,required=True)
p.add_argument('--app-port',type=int,default=18000)
p.add_argument('--grafana-port',type=int,default=13000)
p.add_argument('--public-origin',default='https://helix.localip.ir')
p.add_argument('--require-observations',action='store_true')
a=p.parse_args()
compose=['docker','compose','--env-file',str(a.env_file.resolve()),'-f',str(ROOT/'compose.yaml')]
def check(value,message):
    if not value: raise RuntimeError(message)
def get(url,headers=None):
    with urllib.request.urlopen(urllib.request.Request(url,headers=headers or {}),timeout=10) as r:
        return r.read()
def internal(url):
    code='import urllib.request;print(urllib.request.urlopen('+repr(url)+',timeout=5).read().decode())'
    return json.loads(subprocess.check_output(compose+['exec','-T','app','python','-c',code],text=True,timeout=20))
ps=subprocess.check_output(compose+['ps','--format','json'],text=True)
try: states=json.loads(ps); states=states if isinstance(states,list) else [states]
except json.JSONDecodeError: states=[json.loads(line) for line in ps.splitlines() if line]
check({x['Service'] for x in states}=={'app','prometheus','grafana','node-exporter'},'Expected exactly four Compose services')
check(all(x.get('Health')=='healthy' and x.get('State')=='running' for x in states),'Container health incomplete')
check(json.loads(get(f'http://127.0.0.1:{a.app_port}/api/health'))=={'status':'ok'},'API/DB health failed')
token=a.metrics_token_file.read_text().strip()
body=get(f'http://127.0.0.1:{a.app_port}/internal/metrics',{'Authorization':'Bearer '+token})
r=subprocess.run(compose+['exec','-T','prometheus','promtool','check','metrics'],input=body,capture_output=True,timeout=20)
check(r.returncode==0,'Promtool rejected real application exposition: '+r.stderr.decode())
from urllib.error import HTTPError
for path in ('/internal/metrics','/internal/metrics/','/internal','/metrics','/.env'):
    try:
        get(a.public_origin.rstrip('/')+path)
    except HTTPError as e:
        check(e.code in (403,404),'Unexpected public endpoint response')
    else: raise RuntimeError('Public sensitive path was accessible: '+path)
targets=internal('http://prometheus:9090/api/v1/targets')['data']['activeTargets']
check({x['labels']['job'] for x in targets}=={'helix','node','prometheus'},'Missing scrape targets')
check(all(x['health']=='up' for x in targets),'A real Prometheus target is down')
password=a.grafana_password_file.read_text().strip()
auth={'Authorization':'Basic '+base64.b64encode(('helix-admin:'+password).encode()).decode()}
grafana=f'http://127.0.0.1:{a.grafana_port}'
health=json.loads(get(grafana+'/api/datasources/uid/helix-prometheus/health',auth))
check(health.get('status')=='OK','Grafana cannot query Prometheus')
for name in ('application','infrastructure','services'):
    result=json.loads(get(grafana+'/api/dashboards/uid/helix-'+name,auth))
    check(result['dashboard']['panels'],'Dashboard provisioning missing')
    for panel in result['dashboard']['panels']:
        for target in panel['targets']:
            expr=target['expr']
            result=internal('http://prometheus:9090/api/v1/query?query='+urllib.parse.quote(expr))
            check(result['status']=='success','Dashboard PromQL failed: '+panel['title'])
            if a.require_observations and panel['title'] not in ('Active alerts',):
                check(result['data']['result'],'Dashboard has no real observation: '+panel['title'])
if a.require_observations:
    for expr in ('sum(helix_message_delivery_total{outcome="success"}) > 0',
                 'sum(helix_uploads_total{kind="attachment",outcome="success"}) > 0',
                 'sum(helix_uploads_total{outcome="failure"}) > 0'):
        check(internal('http://prometheus:9090/api/v1/query?query='+urllib.parse.quote(expr))['data']['result'],'Missing real application traffic observation')
print(json.dumps({'services':{x['Service']:x['Health'] for x in states},'targets':{x['labels']['job']:x['health'] for x in targets},'grafana_query':'OK','dashboards':'provisioned; expressions validated','real_observations_required':a.require_observations},indent=2))
