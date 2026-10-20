#!/usr/bin/env python3
"""Fresh, bounded, unsuppressed scans of immutable images; never deploys a stack."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from dotenv import dotenv_values
from image_archive import identity

SCANNER = 'aquasec/trivy:0.76.0@sha256:2416d1f74045b57274df1a340eee6b510cacd73c66a6ccb8da092b117eb7d222'
KEYS = {'app': 'HELIX_IMAGE', 'prometheus': 'PROMETHEUS_IMAGE',
        'grafana': 'GRAFANA_IMAGE', 'node-exporter': 'NODE_EXPORTER_IMAGE'}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--env-file', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True,
                   help='New private evidence directory outside Git')
    a = p.parse_args()
    env = dotenv_values(a.env_file)
    refs = {name: env.get(key, '') for name, key in KEYS.items()}
    if not all(re.fullmatch(r'[^\s]+@sha256:[0-9a-f]{64}', x) for x in refs.values()):
        p.error('Every runtime image must be immutable')
    output = a.output.resolve()
    repo = Path(__file__).resolve().parents[2]
    if output.is_relative_to(repo):
        p.error('Keep raw scanner evidence outside the source repository')
    # Fail before creating evidence if Docker is inaccessible.
    subprocess.run(['docker', 'info', '--format', '{{.ServerVersion}}'], check=True,
                   stdout=subprocess.DEVNULL, timeout=20)
    os.umask(0o077)
    output.mkdir(parents=True, mode=0o700, exist_ok=False)
    work = output / 'scan'; work.mkdir(mode=0o700)
    # Only this fresh work directory is exposed to the non-root scanner.
    if os.geteuid() != 0:
        p.error('Root is required to prepare the isolated scanner UID')
    os.chown(work, 65534, 65534)
    base = ['docker', 'run', '--rm', '--read-only', '--user', '65534:65534',
            '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
            '--memory', '768m', '--cpus', '.5', '--pids-limit', '128',
            '--env', 'TMPDIR=/scan/tmp', '--mount', f'type=bind,src={work},dst=/scan', SCANNER]
    tmp = work / 'tmp'; tmp.mkdir(mode=0o700); os.chown(tmp, 65534, 65534)
    with (output / 'scanner-version.txt').open('x') as log:
        subprocess.run(base + ['--version'], check=True, stdout=log, timeout=120)
    with (output / 'database-update.log').open('x') as log:
        subprocess.run(base + ['image', '--cache-dir', '/scan/cache', '--download-db-only',
                               '--timeout', '5m'], stdout=log, stderr=log, check=True, timeout=360)
    metadata = json.loads((work / 'cache/db/metadata.json').read_text())
    updated = datetime.fromisoformat(metadata['UpdatedAt'].replace('Z', '+00:00'))
    if not 0 <= (datetime.now(timezone.utc) - updated).total_seconds() <= 86400:
        raise RuntimeError('Vulnerability database is stale or has a future timestamp')
    evidence = {'scanner': SCANNER, 'database': metadata, 'images': {}}
    for name, ref in refs.items():
        info = json.loads(subprocess.check_output(['docker', 'image', 'inspect', ref], timeout=20))[0]
        if info['Architecture'] != 'amd64' or info['Os'] != 'linux':
            raise RuntimeError('Unexpected runtime platform')
        archive = work / (name + '.tar')
        subprocess.run(['docker', 'image', 'save', '--output', str(archive), ref], check=True, timeout=300)
        os.chown(archive, 65534, 65534)
        archived = identity(archive, ref.rsplit('@', 1)[1])
        if info['Id'] not in archived.values():
            raise RuntimeError('Docker identity is outside the verified archive chain')
        with (output / (name + '.log')).open('x') as log:
            subprocess.run(base + ['image', '--input', '/scan/' + archive.name,
                '--cache-dir', '/scan/cache', '--skip-db-update', '--scanners', 'vuln',
                '--list-all-pkgs',
                '--ignorefile', '/dev/null', '--ignore-unfixed=false', '--exit-code', '0',
                '--timeout', '5m', '--format', 'json', '--output', '/scan/' + name + '.json'],
                check=True, stdout=log, stderr=log, timeout=360)
        raw = work / (name + '.json')
        if json.loads(raw.read_text())['Metadata']['ImageID'] != archived['config_id']:
            raise RuntimeError('Scanned image identity differs from the selected candidate')
        with archive.open('rb') as f:
            digest = hashlib.file_digest(f, 'sha256').hexdigest()
        evidence['images'][name] = {'reference': ref, 'docker_id': info['Id'],
                                  **archived, 'archive_sha256': digest}
    (output / 'provenance.json').write_text(json.dumps(evidence, indent=2) + '\n')
    # Always collect every report before returning the release-blocking result.
    gate = Path(__file__).with_name('security-gate.py')
    result = subprocess.run([sys.executable, str(gate), '--reports', str(work),
                             '--output', str(output / 'summary.json')], check=False)
    return result.returncode


if __name__ == '__main__':
    raise SystemExit(main())
