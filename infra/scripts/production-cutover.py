#!/usr/bin/env python3
"""Execute or roll back the sealed, independently qualified HELIX release.

No database is restored over another database. The stopped legacy directory
and the Docker directory remain separate through every state transition.
"""
import argparse
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import time
import urllib.request


def require(value, message):
    if not value:
        raise RuntimeError(message)


def sha(path):
    with Path(path).open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()


def run(args, **kw):
    try:
        return subprocess.run(list(map(str, args)), check=True, capture_output=True, timeout=kw.pop('timeout', 120), **kw)
    except subprocess.CalledProcessError as error:
        for output in (error.stdout,error.stderr):
            if output:sys.stderr.buffer.write(output if isinstance(output,bytes) else output.encode())
        raise


class Release:
    def __init__(self, manifest):
        self.m = json.loads(manifest.read_text())
        self.q = Path(self.m['evidence'])
        self.root = Path(self.m['deployment_root'])
        self.nginx = Path('/etc/nginx/sites-available/helix.localip.ir.conf')
        self.old = Path('/var/lib/helix')
        self.retired = Path(self.m['retired_data'])
        self.marker = Path('/var/lib/helix-deploy/docker-active')
        self.compose = ['docker','compose','--env-file','/etc/helix/docker-compose.env',
                        '-f',str(self.root/'infra/compose.yaml')]

    def event(self, name, **values):
        with (self.q/'transaction.jsonl').open('a') as f:
            f.write(json.dumps({'at':datetime.now(timezone.utc).isoformat(),'event':name,**values})+'\n')
            f.flush(); os.fsync(f.fileno())
        print(name, flush=True)

    def route(self, path):
        temporary = self.nginx.with_suffix('.pending')
        shutil.copyfile(path, temporary); os.chmod(temporary, 0o644)
        os.replace(temporary, self.nginx)
        run(['nginx','-t']); run(['systemctl','reload','nginx'])

    def old_inactive(self):
        require(run(['systemctl','show','helix','-p','ActiveState','--value']).stdout.strip()==b'inactive', 'Legacy writer still active')
        require(run(['systemctl','show','helix','-p','MainPID','--value']).stdout.strip()==b'0', 'Legacy PID remains')

    def preflight(self):
        require(os.geteuid()==0, 'Real host root required')
        require(not self.marker.exists() and not self.retired.exists(), 'Already activated or retired')
        for path, expected in self.m['sealed_files'].items():
            require(sha(path)==expected, 'Release input drift: '+path)
        require(sha(self.nginx)==self.m['old_nginx_sha256'], 'Production Nginx drift')
        require(sha('/etc/systemd/system/helix.service')==self.m['old_unit_sha256'], 'Legacy unit drift')
        require(run(['systemctl','show','helix','-p','MainPID','--value']).stdout.strip().decode()==str(self.m['old_pid']), 'Legacy runtime drift')
        gate=json.loads((self.q/'application-security.json').read_text())
        require(gate['decision']=='PASS — REVIEWED APPLICATION SECURITY' and gate['image']==self.m['image'], 'Application gate failed')
        tests=json.loads((self.q/'qualification.json').read_text())
        require(tests['backend']==148 and tests['frontend']==99 and tests['chromium_phases']==8
                and tests['interop']==1 and tests['security']==11 and tests['safety']==20, 'Qualification incomplete')
        data=Path('/var/lib/helix-docker/data')
        require(data.resolve()!=self.old.resolve(), 'Database paths collide')
        with sqlite3.connect((data/'smooth.db').as_uri()+'?mode=ro',uri=True) as db:
            require(db.execute('PRAGMA integrity_check').fetchall()==[('ok',)] and not db.execute('PRAGMA foreign_key_check').fetchone(), 'Fresh DB integrity failed')
            require(all(db.execute('SELECT count(*) FROM '+t).fetchone()[0]==0 for t in ('users','conversations','messages','message_attachments')), 'Fresh DB not empty')
        require(not list((data/'uploads').iterdir()), 'Fresh uploads not empty')
        for p,mode in [(data,0o700),(data/'uploads',0o700),(data/'smooth.db',0o600),(data/'.helix-fresh-bootstrap-v1',0o600)]:
            st=p.lstat();require(not p.is_symlink() and st.st_uid==st.st_gid==10001 and st.st_mode & 0o777==mode, 'Unsafe storage permissions')
        for p in ['/etc/helix/docker-production.env','/etc/helix/docker-compose.env']:
            st=Path(p).lstat(); require(not Path(p).is_symlink() and st.st_uid==0 and st.st_mode & 0o077==0, 'Unprotected secret/config')
        for file in self.m['secret_files']:
            p=Path(file);st=p.lstat();parent=p.parent.stat()
            # Compose file secrets are read-only bind mounts, shared by distinct
            # non-root UIDs. Host access is restricted by the root-only parent.
            require(not p.is_symlink() and st.st_uid==0 and st.st_mode & 0o222==0
                    and parent.st_uid==0 and parent.st_mode & 0o077==0, 'Unprotected secret bind source')
        ids=run(['docker','ps','-q']).stdout.decode().split()
        for cid in ids:
            info=json.loads(run(['docker','inspect',cid]).stdout)[0]
            require(not any(m['Source'] in (str(data),str(self.old)) for m in info['Mounts']), 'Concurrent production Docker writer')
            require('grafana' not in info['Name'], 'Unverified Grafana must remain stopped')
        run(self.compose+['config','--quiet'])
        config=json.loads(run(self.compose+['config','--format','json']).stdout)
        require(set(config['services'])=={'app','prometheus','node-exporter'}, 'Default stack reactivates Grafana')
        app=config['services']['app']
        require(app['image']==self.m['image'] and app['read_only'] and app['cap_drop']==['ALL'] and app['user']=='10001:10001'
                and app['security_opt']==['no-new-privileges:true'] and app['deploy']['replicas']==1, 'Application hardening drift')
        require(app['ports'][0]['host_ip']=='127.0.0.1', 'Public app listener')
        require(not app.get('privileged') and not app.get('devices') and app.get('pid')!='host'
                and not any('docker.sock' in str(v) for v in app.get('volumes',[])), 'Unsafe application host access')
        # Rule tests need temporary TSDB files. Qualify them in an isolated
        # runner before maintenance; the real Prometheus root stays read-only.
        tested=run(['docker','run','--rm','--network','none','--read-only','--user','65534:65534',
            '--cap-drop','ALL','--security-opt','no-new-privileges','--memory','256m','--cpus','.5',
            '--pids-limit','64','--tmpfs','/tmp:rw,noexec,nosuid,nodev,size=64m',
            '--mount',f'type=bind,src={self.root}/infra/prometheus,dst=/etc/prometheus,readonly',
            '--workdir','/etc/prometheus','--entrypoint','/bin/promtool',config['services']['prometheus']['image'],
            'test','rules','alerts.test.yml'])
        (self.q/'alert-rules-preflight.log').write_bytes(tested.stdout+tested.stderr)
        self.event('preflight_passed')

    def archive(self):
        self.old_inactive()
        snapshot=self.q/'old-offline'; snapshot.mkdir(mode=0o700)
        run([sys.executable,self.root/'infra/scripts/data-safety.py','snapshot','--data',self.old,
             '--env','/etc/helix/production.env','--output',snapshot/'data','--inactive-unit','helix.service'])
        shutil.copytree(Path('/opt/helix/current').resolve(),snapshot/'release',symlinks=True)
        config=snapshot/'configuration';config.mkdir()
        for path,name in [(self.nginx,'nginx.conf'),(Path('/etc/systemd/system/helix.service'),'helix.service'),
                          (self.q/'baseline/nginx-site.conf','nginx-rollback.conf'),
                          (Path('/etc/letsencrypt/live/helix.localip.ir/fullchain.pem'),'fullchain.pem'),
                          (Path('/etc/letsencrypt/live/helix.localip.ir/privkey.pem'),'privkey.pem')]:
            shutil.copyfile(path,config/name)
        hashes={str(p.relative_to(snapshot)):sha(p) for p in snapshot.rglob('*') if p.is_file() and not p.is_symlink()}
        (snapshot/'sha256.json').write_text(json.dumps(hashes,indent=2)+'\n')
        archive=self.q/'old-systemd-offline.tar.gz'
        with tarfile.open(archive,'w:gz',compresslevel=3) as tar: tar.add(snapshot,arcname='old-systemd',recursive=True)
        with tarfile.open(archive,'r:gz') as tar:
            restored=self.q/'archive-restore-check.db'
            verified=set()
            # A single sequential pass avoids quadratic gzip re-decompression
            # when filesystem traversal and tar member order differ.
            for member in tar:
                name=member.name.removeprefix('old-systemd/')
                if name not in hashes:continue
                require(member.isfile(), 'Archive regular file type changed')
                data=tar.extractfile(member).read()
                require(hashlib.sha256(data).hexdigest()==hashes[name], 'Archive byte mismatch')
                verified.add(name)
                if name=='data/smooth.db':restored.write_bytes(data)
            require(verified==set(hashes), 'Archive files missing')
        with sqlite3.connect(restored) as db:
            require(db.execute('PRAGMA integrity_check').fetchall()==[('ok',)] and not db.execute('PRAGMA foreign_key_check').fetchone(), 'Archived database invalid')
        os.chmod(archive,0o400)
        with archive.open('rb') as f: os.fsync(f.fileno())
        self.event('stopped_writer_archive_verified',archive=str(archive),sha256=sha(archive),regular_files=len(hashes))

    def rollback(self):
        self.event('rollback_started')
        self.route(self.root/'infra/nginx/helix-maintenance.conf')
        run(self.compose+['stop','app'])
        ids=run(self.compose+['ps','-q','app']).stdout.strip();require(not ids, 'Docker writer still running')
        # Preserve the fresh DB and every accepted upload in place; never restore
        # the old database into Docker storage.
        if self.retired.exists():
            if self.old.exists(): self.old.rmdir()
            os.rename(self.retired,self.old)
        require((self.old/'smooth.db').is_file(), 'Legacy storage missing')
        if self.marker.exists(): self.marker.unlink()
        run(['systemctl','reset-failed','helix']);run(['systemctl','start','helix'])
        for _ in range(60):
            try:
                with urllib.request.urlopen('http://127.0.0.1:8000/api/health',timeout=2) as r:
                    if r.status==200:break
            except OSError:time.sleep(.5)
        else:raise RuntimeError('Legacy rollback runtime failed')
        self.route(self.q/'baseline/nginx-site.conf')
        self.event('rollback_complete',fresh_data_preserved=True)

    def execute(self):
        self.preflight()
        self.route(self.root/'infra/nginx/helix-maintenance.conf')
        try:
            self.event('maintenance_active')
            drop=Path('/etc/systemd/system/helix.service.d');drop.mkdir(exist_ok=True)
            shutil.copyfile(self.root/'infra/systemd/helix-docker-writer-guard.conf',drop/'docker-writer-guard.conf')
            run(['systemctl','daemon-reload']);run(['systemctl','stop','helix']);self.old_inactive()
            self.event('legacy_writer_stopped')
            self.archive()
            os.rename(self.old,self.retired);self.old.mkdir(mode=0o000)
            with self.marker.open('x') as f:
                f.write(self.m['image']+'\n');f.flush();os.fsync(f.fileno())
            # Qualification networks conflict by design with production subnets.
            # Keep all qualification volumes; production gets separate TSDBs.
            for unit in ['helix2121-qualification-collector.timer','helix2121-qualification-proxy.service',
                         'helix212-qualification-proxy.service']:
                state=subprocess.run(['systemctl','show',unit,'-p','LoadState','--value'],capture_output=True,timeout=15)
                require(state.stdout.strip() in (b'loaded',b'not-found'), 'Unexpected qualification unit state')
                # Transient qualification units disappear after their first
                # stop. A retried transaction must accept their absence.
                if state.stdout.strip()==b'loaded':run(['systemctl','stop',unit])
            run(['docker','compose','--env-file',self.m['qualification_env'],'-f',self.root/'infra/compose.yaml',
                 '--profile','grafana-reviewed','down'],timeout=180)
            self.old_inactive()
            run(self.compose+['up','-d','--no-build','--pull','never','--wait','--wait-timeout','100','app','prometheus','node-exporter'],timeout=180)
            run(self.compose+['exec','-T','prometheus','promtool','check','config','/etc/prometheus/prometheus.yml'])
            for name in ['helix-production-collector.service','helix-production-collector.timer']:
                shutil.copyfile(self.root/'infra/systemd'/name,Path('/etc/systemd/system')/name)
            run(['systemctl','daemon-reload']);run(['systemctl','enable','--now','helix-production-collector.timer'])
            run(['systemctl','start','helix-production-collector.service'])
            self.event('docker_healthy_legacy_inactive')
            self.route(self.root/'infra/nginx/helix-docker.conf')
            self.event('public_docker_route_active')
            with (self.q/'production-acceptance.log').open('wb') as log:
                subprocess.run(self.m['acceptance_command'],stdout=log,stderr=log,check=True,timeout=240)
            self.event('public_acceptance_passed')
            run([sys.executable,self.root/'infra/scripts/verify-production.py','--manifest',self.q/'release-manifest.json'],timeout=180)
            self.event('production_verified')
        except BaseException as error:
            self.event('mandatory_acceptance_failed',error_type=type(error).__name__)
            self.rollback()
            raise


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--manifest',type=Path,required=True)
    p.add_argument('action',choices=['check','execute','rollback'])
    a=p.parse_args();os.umask(0o077)
    with Path('/var/lib/helix-deploy/lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        r=Release(a.manifest)
        {'check':r.preflight,'execute':r.execute,'rollback':r.rollback}[a.action]()
