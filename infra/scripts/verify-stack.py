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
p.add_argument('--expected-panels',type=int,default=30,
    help='Reviewed panel inventory; defaults to the requested 30, not query count')
a=p.parse_args()
compose=['docker','compose','--env-file',str(a.env_file.resolve()),'-f',str(ROOT/'compose.yaml')]
def check(value,message):
    if not value: raise RuntimeError(message)
def get(url,headers=None):
    with urllib.request.urlopen(urllib.request.Request(url,headers=headers or {}),timeout=10) as r:
        return r.read()
def post(url,payload,headers):
    request=urllib.request.Request(url,data=json.dumps(payload).encode(),headers={**headers,'Content-Type':'application/json'})
    with urllib.request.urlopen(request,timeout=20) as response:
        return json.load(response)
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
dashboard_evidence={}
panel_count=0
query_count=0
for name in ('application','infrastructure','services'):
    result=json.loads(get(grafana+'/api/dashboards/uid/helix-'+name,auth))
    check(result['dashboard']['panels'],'Dashboard provisioning missing')
    dashboard_evidence[name]=[]
    panel_count+=len(result['dashboard']['panels'])
    for panel in result['dashboard']['panels']:
        panel_evidence={'id':panel['id'],'panel':panel['title'],'queries':[]}
        for target in panel['targets']:
            query_count+=1
            expr=target['expr']
            result=internal('http://prometheus:9090/api/v1/query?query='+urllib.parse.quote(expr))
            check(result['status']=='success','Dashboard PromQL failed: '+panel['title'])
            if a.require_observations and panel['title'] not in ('Active alerts',):
                check(result['data']['result'],'Dashboard has no real observation: '+panel['title'])
            # Query through Grafana's real datasource plugin as well as Prometheus.
            frames=post(grafana+'/api/ds/query',{'from':str(int((time.time()-300)*1000)),'to':str(int(time.time()*1000)),
                'queries':[{'refId':'A','datasource':{'uid':'helix-prometheus','type':'prometheus'},'expr':expr,'instant':True,'range':False,'intervalMs':15000,'maxDataPoints':300}]},auth)['results']['A']
            check(not frames.get('error'),'Grafana datasource query failed: '+panel['title'])
            observed=any(len(frame.get('data',{}).get('values',[]))>=2 and
                         any(value is not None for value in frame['data']['values'][-1])
                         for frame in frames.get('frames',[]))
            if a.require_observations and panel['title']!='Active alerts':
                check(observed,'Grafana returned no measured values: '+panel['title'])
            panel_evidence['queries'].append({'refId':target['refId'],'prometheus_series':len(result['data']['result']),'grafana_frames':len(frames.get('frames',[]))})
        dashboard_evidence[name].append(panel_evidence)
check(panel_count==a.expected_panels,f'Dashboard inventory differs: expected {a.expected_panels} panels, found {panel_count} panels / {query_count} queries. Review the inventory; queries are not panels.')
if a.require_observations:
    for expr in ('sum(helix_message_delivery_total{outcome="success"}) > 0',
                 'sum(helix_uploads_total{kind="attachment",outcome="success"}) > 0',
                 'sum(helix_uploads_total{outcome="failure"}) > 0'):
        check(internal('http://prometheus:9090/api/v1/query?query='+urllib.parse.quote(expr))['data']['result'],'Missing real application traffic observation')
print(json.dumps({'services':{x['Service']:x['Health'] for x in states},'targets':{x['labels']['job']:x['health'] for x in targets},'grafana_query':'OK','dashboards':dashboard_evidence,'panel_count':panel_count,'query_count':query_count,'real_observations_required':a.require_observations},indent=2))
