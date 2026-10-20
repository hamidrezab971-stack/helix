#!/usr/bin/env python3
"""Create monitoring-only secrets, never rotate application signing keys."""
import argparse
import os
from pathlib import Path
import secrets

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('directory',type=Path)
a=p.parse_args()
os.umask(0o077)
a.directory.mkdir(mode=0o700,parents=True,exist_ok=False)
for name in ('metrics_token','grafana_password','grafana_secret_key'):
    fd=os.open(a.directory/name,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o400)
    with os.fdopen(fd,'w') as f:
        f.write(secrets.token_urlsafe(48)+'\n'); f.flush(); os.fsync(f.fileno())
    # Compose local secrets are bind files: world readable inside each assigned
    # container, protected on host by root-only 0700 parent. No shared host dir.
    os.chmod(a.directory/name,0o444)
print('Monitoring secrets created; values withheld. Keep parent directory mode 0700.')
