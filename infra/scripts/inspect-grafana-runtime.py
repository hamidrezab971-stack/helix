#!/usr/bin/env python3
"""Inventory embedded Go modules in an immutable Grafana image without starting it.

Inspect every regular ELF in Docker's merged filesystem, including bundled
datasource executables. Read build info, replacements and vendoring flags from
the binary itself; source go.mod is not evidence of what was shipped.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile

MODULE = 'github.com/getkin/kin-openapi'


def inspect(image, go, workspace):
    metadata = json.loads(subprocess.check_output(
        ['docker', 'image', 'inspect', image], timeout=20))[0]
    # Creating a container does not execute its entrypoint. No production
    # volumes, networks or secrets are attached to this disposable container.
    cid = subprocess.check_output([
        'docker', 'create', '--network', 'none', '--read-only',
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '--entrypoint', '/__never_execute__', image,
    ], text=True, timeout=30).strip()
    binaries = []
    non_go = []
    export = None
    try:
        with tempfile.TemporaryDirectory(prefix='grafana-buildinfo-', dir=workspace) as tmp:
            binary = Path(tmp) / 'binary'
            export = subprocess.Popen(['docker', 'export', cid], stdout=subprocess.PIPE)
            with tarfile.open(fileobj=export.stdout, mode='r|') as archive:
                for member in archive:
                    if not member.isfile():
                        continue
                    with archive.extractfile(member) as stream:
                        magic = stream.read(4)
                        if magic != b'\x7fELF':
                            continue
                        # Never extract archive paths or follow image symlinks.
                        with binary.open('wb') as output:
                            output.write(magic)
                            shutil.copyfileobj(stream, output)
                    with binary.open('rb') as stream:
                        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
                    result = subprocess.run([go, 'version', '-m', '-json', str(binary)],
                                            capture_output=True, text=True, timeout=30,
                                            env={**os.environ, 'GOTOOLCHAIN': 'local'})
                    if result.returncode:
                        non_go.append({'path': member.name, 'sha256': digest,
                                       'inspection': result.stderr.strip()})
                        continue
                    info = json.loads(result.stdout)
                    info.pop('Name', None)  # Temporary host pathname is irrelevant.
                    modules = [dep for dep in info.get('Deps', []) if dep['Path'] == MODULE
                               or dep.get('Replace', {}).get('Path') == MODULE]
                    binaries.append({'path': member.name, 'sha256': digest,
                                     'size': member.size, 'kin_openapi': modules,
                                     'build_info': info})
            if export.wait(timeout=30) != 0:
                raise RuntimeError('Docker filesystem export failed')
    finally:
        if export is not None and export.poll() is None:
            export.kill()
            export.wait(timeout=10)
        subprocess.run(['docker', 'rm', cid], check=True,
                       stdout=subprocess.DEVNULL, timeout=30)
    if not any(b['path'] == 'usr/share/grafana/bin/grafana' for b in binaries):
        raise RuntimeError('Grafana main build information was not inspected')
    return {'at': datetime.now(timezone.utc).isoformat(), 'image': image,
            'docker_image_id': metadata['Id'], 'repo_digests': metadata['RepoDigests'],
            'inspection_tool': subprocess.check_output([go, 'version'], text=True).strip(),
            'image_started': False, 'all_regular_elf_inspected': True,
            'go_binaries': binaries, 'other_elf': non_go,
            'signature_verified': False, 'release_authorized': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', required=True)
    parser.add_argument('--go', default='go', help='Trusted Go tool used only to read build info')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if not re.fullmatch(r'[^\s]+@sha256:[0-9a-f]{64}', args.image):
        parser.error('An immutable image reference is required')
    if args.output.exists():
        parser.error('Refusing to overwrite evidence')
    os.umask(0o077)
    result = inspect(args.image, args.go, args.output.resolve().parent)
    with args.output.open('x') as output:
        json.dump(result, output, indent=2)
        output.write('\n')
    print(json.dumps({'image': args.image, 'go_binaries': len(result['go_binaries']),
                      'kin_openapi': [{'path': b['path'], 'modules': b['kin_openapi']}
                                      for b in result['go_binaries'] if b['kin_openapi']],
                      'release_authorized': False}, indent=2))


if __name__ == '__main__':
    main()
