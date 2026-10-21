#!/usr/bin/env python3
"""Resolve explicitly reviewed image tags to immutable amd64 registry digests."""
import argparse
import json
from pathlib import Path
import re
import subprocess

p=argparse.ArgumentParser(description=__doc__)
for name in ('node','python','prometheus','grafana','node-exporter'):
    p.add_argument('--'+name, required=True, help='Reviewed repository:exact-version tag')
p.add_argument('--output',type=Path,required=True)
a=p.parse_args()
resolved=[]
for key in ('node','python','prometheus','grafana','node_exporter'):
    ref=getattr(a,key)
    if not re.fullmatch(r'[a-zA-Z0-9./_-]+:[a-zA-Z0-9._-]+',ref) or ref.endswith(':latest'):
        p.error('Use explicit version tags; latest and shell expressions are rejected.')
    subprocess.run(['docker','pull','--platform','linux/amd64',ref],check=True)
    info=json.loads(subprocess.check_output(['docker','image','inspect',ref]))[0]
    if info['Architecture'] != 'amd64': raise SystemExit('Expected linux/amd64 image')
    repo=ref.rsplit(':',1)[0]
    digests=info.get('RepoDigests',[])
    match=next((x for x in digests if x.split('@')[0] in (repo,'docker.io/'+repo,'docker.io/library/'+repo)),None)
    if not match or not re.search(r'@sha256:[0-9a-f]{64}$',match):
        raise SystemExit('Registry did not supply the expected immutable digest')
    resolved.append(f'{key.upper()}_IMAGE={ref}@{match.split("@")[1]}')
with a.output.open('x') as f: f.write('\n'.join(resolved)+'\n')
print('Digest lock written. Review and preserve this file with the release evidence.')
