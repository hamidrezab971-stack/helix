#!/usr/bin/env python3
"""Real TLS/WSS, durable storage, runtime and private metrics acceptance."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import socket
import sqlite3
import ssl
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from wsproto import WSConnection, ConnectionType
from wsproto.events import Request, AcceptConnection, RejectConnection, TextMessage, CloseConnection


def require(value,message):
    if not value: raise RuntimeError(message)


def run(args,**kw):
    return subprocess.run(list(map(str,args)),check=True,capture_output=True,timeout=kw.pop('timeout',120),**kw)


def request(path, value=None, token=None, data=None, content_type='application/json'):
    headers={'Content-Type':content_type}
    if token: headers['Authorization']='Bearer '+token
    if value is not None: data=json.dumps(value).encode()
    with urllib.request.urlopen(urllib.request.Request('https://helix.localip.ir'+path,data=data,headers=headers),timeout=20) as r:
        return r.read()


def login(account):
    challenge=json.loads(request('/api/auth/challenge?purpose=login'));p=challenge['parameters']
    require(p['algorithm']=='PBKDF2/SHA-256' and p['cost']<=10000,'Unexpected CAPTCHA')
    for counter in range(100000):
        key=hashlib.pbkdf2_hmac('sha256',bytes.fromhex(p['nonce'])+counter.to_bytes(4,'big'),bytes.fromhex(p['salt']),p['cost'],p['keyLength']).hex()
        if key.startswith(p['keyPrefix']):break
    else:raise RuntimeError('Real CAPTCHA could not be solved')
    proof=base64.b64encode(json.dumps({'challenge':challenge,'solution':{'counter':counter,'derivedKey':key}}).encode()).decode()
    return json.loads(request('/api/auth/login',{'username':account['username'],'password':account['password'],'altcha':proof}))['access_token']


def websocket(origin):
    s=ssl.create_default_context().wrap_socket(socket.create_connection(('helix.localip.ir',443),timeout=15),server_hostname='helix.localip.ir')
    ws=WSConnection(ConnectionType.CLIENT)
    s.sendall(ws.send(Request(host='helix.localip.ir',target='/ws',extra_headers=[(b'origin',origin.encode())])))
    while True:
        ws.receive_data(s.recv(65536))
        for event in ws.events():
            if isinstance(event,(AcceptConnection,RejectConnection)):return s,ws,event


def receive(s,ws,kind):
    deadline=time.monotonic()+20
    while time.monotonic()<deadline:
        ws.receive_data(s.recv(65536))
        for e in ws.events():
            if isinstance(e,TextMessage):
                v=json.loads(e.data)
                if v.get('type')==kind:return v
    raise RuntimeError('Missing WSS event '+kind)


def durable():
    data=Path('/var/lib/helix-docker/data')
    with sqlite3.connect((data/'smooth.db').as_uri()+'?mode=ro',uri=True) as db:
        require(db.execute('PRAGMA integrity_check').fetchall()==[('ok',)] and not db.execute('PRAGMA foreign_key_check').fetchone(),'Database invalid')
        tables=[r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
        rows={t:db.execute('SELECT * FROM "'+t+'" ORDER BY rowid').fetchall() for t in tables}
    return {'rows_sha256':hashlib.sha256(json.dumps(rows,sort_keys=True,default=str).encode()).hexdigest(),
            'counts':{t:len(v) for t,v in rows.items()},
            'uploads':{str(p.relative_to(data/'uploads')):hashlib.sha256(p.read_bytes()).hexdigest() for p in (data/'uploads').rglob('*') if p.is_file()}}


def main(manifest,exercise_persistence):
    m=json.loads(manifest.read_text());q=Path(m['evidence']);root=Path(m['deployment_root'])
    compose=['docker','compose','--env-file','/etc/helix/docker-compose.env','-f',str(root/'infra/compose.yaml')]
    fixture=json.loads((q/'acceptance/accounts.json').read_text())
    tokens=list(map(login,fixture['accounts']))
    result={'tls':[]}
    for version in (ssl.TLSVersion.TLSv1_2,ssl.TLSVersion.TLSv1_3):
        ctx=ssl.create_default_context();ctx.minimum_version=version;ctx.maximum_version=version
        with ctx.wrap_socket(socket.create_connection(('helix.localip.ir',443),timeout=15),server_hostname='helix.localip.ir') as s:
            result['tls'].append(s.version())
    for path,expected in m['public_files'].items():
        require(hashlib.sha256(request(path)).hexdigest()==expected,'Public image asset mismatch: '+path)
    for path in ['/internal/metrics','/internal/metrics/','/internal','/metrics','/.env','/docs','/openapi.json']:
        try:request(path)
        except urllib.error.HTTPError as e:require(e.code==404,'Sensitive path not blocked')
        else:raise RuntimeError('Public sensitive path accessible: '+path)
    if exercise_persistence:
        # A brief maintenance interval avoids exposing a broken upstream while
        # actual production rows and files survive container replacement.
        nginx=Path('/etc/nginx/sites-available/helix.localip.ir.conf')
        import shutil
        shutil.copyfile(root/'infra/nginx/helix-maintenance.conf',nginx)
        run(['nginx','-t']);run(['systemctl','reload','nginx'])
        run(compose+['stop','app'])
        before=durable()
        old_cid=run(compose+['ps','-a','-q','app']).stdout.strip()
        with (q/'production-recreation.log').open('wb') as log:
            subprocess.run(compose+['up','-d','--no-deps','--no-build','--pull','never','--force-recreate','--wait','--wait-timeout','90','app'],check=True,stdout=log,stderr=log,timeout=120)
        require(old_cid!=run(compose+['ps','-q','app']).stdout.strip(),'Container was not recreated')
        require(durable()==before,'Production rows or uploads changed across recreation')
        shutil.copyfile(root/'infra/nginx/helix-docker.conf',nginx)
        run(['nginx','-t']);run(['systemctl','reload','nginx'])
        for _ in range(40):
            try:
                if json.loads(request('/api/health'))=={'status':'ok'}:break
            except (OSError,ValueError):time.sleep(.25)
        else:raise RuntimeError('Public routing did not recover after recreation')
        result['container_recreation_persistence']=True
    for account,token in zip(fixture['accounts'],tokens):
        require(json.loads(request('/api/auth/me',token=token))['id']==account['id'],'JWT did not survive restart')
    result['persistent_signing_secrets']=True
    alice,bob=tokens
    require(request('/api/attachments/'+str(fixture['attachmentId'])+'/content',token=bob)==Path(fixture['imagePath'].replace('/acceptance',str(q/'acceptance'))).read_bytes(),'Attachment persistence failed')
    s,ws,event=websocket('https://helix.localip.ir');require(isinstance(event,AcceptConnection),'WSS upgrade failed')
    s.sendall(ws.send(TextMessage(data=json.dumps({'type':'auth','token':bob}))))
    receive(s,ws,'presence:snapshot')
    path='/api/conversations/'+str(fixture['conversationId'])+'/messages'
    message=json.loads(request(path,{'content':'Production persistence and metrics acceptance'},alice))
    require(receive(s,ws,'message:new')['data']['id']==message['id'],'WSS message delivery failed')
    image=(q/'acceptance/qa.png').read_bytes();boundary='helix-release-acceptance-boundary'
    body=('--'+boundary+'\r\nContent-Disposition: form-data; name="file"; filename="qa.png"\r\nContent-Type: image/png\r\n\r\n').encode()+image+('\r\n--'+boundary+'--\r\n').encode()
    uploaded=json.loads(request(path+'/image',token=alice,data=body,content_type='multipart/form-data; boundary='+boundary))
    require(receive(s,ws,'message:new')['data']['id']==uploaded['id'],'WSS image delivery failed')
    require(request('/api/attachments/'+str(uploaded['attachment']['id'])+'/content',token=bob)==image,'Live image content mismatch')
    s.sendall(ws.send(CloseConnection(code=1000)));s.close()
    s,ws,event=websocket('https://evil.invalid');require(isinstance(event,RejectConnection) and event.status_code==403,'Foreign WSS origin accepted');s.close()
    result.update(authenticated_wss=True,text_image_delivery=True,foreign_origin_rejected=True)
    states=json.loads(run(['docker','inspect']+run(compose+['ps','-q']).stdout.decode().split()).stdout)
    require({v['Config']['Labels']['com.docker.compose.service'] for v in states}=={'app','prometheus','node-exporter'},'Unexpected production service')
    require(all(v['State']['Health']['Status']=='healthy' and v['State']['Running'] for v in states),'Container health incomplete')
    app=next(v for v in states if v['Config']['Labels']['com.docker.compose.service']=='app')
    require(app['Config']['Image']==m['image'] and app['HostConfig']['ReadonlyRootfs'] and app['HostConfig']['CapDrop']==['ALL'] and app['Config']['User']=='10001:10001','Runtime security drift')
    require(app['HostConfig']['PortBindings']=={'8000/tcp':[{'HostIp':'127.0.0.1','HostPort':'18000'}]},'Application publicly published')
    require(run(['systemctl','show','helix','-p','MainPID','--value']).stdout.strip()==b'0','Legacy writer running')
    require(Path('/var/lib/helix-deploy/docker-active').is_file() and Path(m['retired_data']).is_dir() and not list(Path('/var/lib/helix').iterdir()),'Legacy data not isolated')
    token=Path('/etc/helix/docker-secrets/metrics_token').read_text().strip()
    with urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:18000/internal/metrics',headers={'Authorization':'Bearer '+token}),timeout=10) as r:metrics=r.read()
    run(compose+['exec','-T','prometheus','promtool','check','metrics'],input=metrics)
    def prometheus(path):
        code='import urllib.request;print(urllib.request.urlopen('+repr('http://prometheus:9090'+path)+',timeout=10).read().decode())'
        return json.loads(run(compose+['exec','-T','app','python','-c',code]).stdout)
    for _ in range(12):
        targets=prometheus('/api/v1/targets')['data']['activeTargets']
        if len(targets)==3 and all(v['health']=='up' for v in targets):break
        time.sleep(3)
    require({v['labels']['job'] for v in targets}=={'helix','prometheus','node'} and all(v['health']=='up' for v in targets),'Private scrape targets unhealthy')
    for expr in ['sum(helix_message_delivery_total{outcome="success"}) > 0','sum(helix_uploads_total{kind="attachment",outcome="success"}) > 0']:
        for _ in range(12):
            values=prometheus('/api/v1/query?query='+urllib.parse.quote(expr))['data']['result']
            if values:break
            time.sleep(3)
        require(values,'Missing actual production metrics observation')
    result.update(services={v['Config']['Labels']['com.docker.compose.service']:v['State']['Health']['Status'] for v in states},
                  targets={v['labels']['job']:v['health'] for v in targets},
                  image=m['image'],public_fingerprint_verified=True,metrics_private=True,
                  production_rows=durable(),at=time.time())
    (q/('production-verification.json' if exercise_persistence else 'production-recheck.json')).write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result,indent=2))


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--manifest',type=Path,required=True)
    p.add_argument('--read-only-lifecycle',action='store_true',help='Skip container replacement; still sends synthetic acceptance messages')
    a=p.parse_args();main(a.manifest,not a.read_only_lifecycle)
