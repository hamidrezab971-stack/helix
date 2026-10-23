#!/usr/bin/env python3
"""Build and qualify Grafana on a disposable Actions runner, never on production."""
import argparse
import ast
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import shutil
import stat
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import base64
import zipfile

ROOT = Path(__file__).resolve().parents[2]
INPUTS = json.loads((ROOT / 'infra/security/grafana-build-inputs.json').read_text())
OUT = ROOT / 'out'
SOURCE = ROOT / 'upstream'
IMAGE = 'helix-grafana:qualified-candidate'


def run(args, **kwargs):
    return subprocess.run([str(a) for a in args], check=True, **kwargs)


def write(name, data):
    (OUT / name).write_text(json.dumps(data, indent=2) + '\n')


def sha(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def verify_plugin(archive, source, destination):
    """Verify Grafana's PGP signature and every file before extracting the ZIP."""
    if sha(archive) != INPUTS['prometheus_plugin_archive_sha256']:
        raise RuntimeError('Publisher plugin archive digest mismatch')
    key_source = (source / 'pkg/plugins/manager/signature/statickey/static_retriever.go').read_text()
    key = re.search(r'-----BEGIN PGP PUBLIC KEY BLOCK-----.*?-----END PGP PUBLIC KEY BLOCK-----',
                    key_source, re.S).group(0)
    with tempfile.TemporaryDirectory() as temp:
        home = Path(temp); os.chmod(home, 0o700)
        (home / 'key.asc').write_text(key)
        run(['gpg', '--batch', '--homedir', home, '--import', home / 'key.asc'], capture_output=True)
        with zipfile.ZipFile(archive) as z:
            names = [i.filename for i in z.infolist() if not i.is_dir()]
            if len(names) != len(set(names)):
                raise RuntimeError('Duplicate plugin archive paths')
            for member in z.infolist():
                path = PurePosixPath(member.filename)
                if (path.is_absolute() or '..' in path.parts or not path.parts
                        or path.parts[0] != 'prometheus'
                        or stat.S_ISLNK(member.external_attr >> 16)):
                    raise RuntimeError('Unsafe plugin archive member')
            manifest_path = home / 'MANIFEST.txt'
            manifest_path.write_bytes(z.read('prometheus/MANIFEST.txt'))
            checked = run(['gpg', '--batch', '--homedir', home, '--status-fd', '2',
                           '--decrypt', manifest_path], capture_output=True)
            if b'[GNUPG:] VALIDSIG ' not in checked.stderr:
                raise RuntimeError('Publisher plugin PGP signature was not verified')
            manifest = json.loads(checked.stdout)
            if (manifest['plugin'], manifest['version'], manifest['signatureType'],
                    manifest['signedByOrg']) != ('prometheus', INPUTS['prometheus_plugin_version'],
                                                'grafana', 'grafana'):
                raise RuntimeError('Unexpected signed publisher plugin identity')
            expected = {'prometheus/' + n for n in manifest['files']} | {'prometheus/MANIFEST.txt'}
            if set(names) != expected:
                raise RuntimeError('Missing or unsigned plugin files')
            for name, digest in manifest['files'].items():
                if hashlib.sha256(z.read('prometheus/' + name)).hexdigest() != digest:
                    raise RuntimeError('Plugin file differs from signed manifest: ' + name)
            destination.mkdir(parents=True, exist_ok=False)
            for name in names:
                target = destination.joinpath(*PurePosixPath(name).parts[1:])
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(z.read(name))
            return {'archive_sha256': sha(archive), 'version': manifest['version'],
                    'signed_files': len(manifest['files']), 'pgp_status': checked.stderr.decode('utf-8', 'replace'),
                    'signature_verified': True, 'all_files_verified': True}


def prepare():
    OUT.mkdir(exist_ok=True)
    actual = subprocess.check_output(['git', '-C', SOURCE, 'rev-parse', 'HEAD'], text=True).strip()
    if actual != INPUTS['grafana_source']:
        raise RuntimeError('Upstream source commit mismatch')
    commit = json.loads(subprocess.check_output([
        'gh', 'api', 'repos/grafana/grafana/commits/' + actual]))
    if not commit['commit']['verification']['verified']:
        raise RuntimeError('Upstream source commit signature was not verified by GitHub')
    write('upstream-commit-verification.json', commit['commit']['verification'])
    patch = ROOT / 'infra/security/grafana.patch'
    run(['git', '-C', SOURCE, 'apply', '--check', '--unidiff-zero', patch])
    run(['git', '-C', SOURCE, 'apply', '--unidiff-zero', patch])
    run(['gh', 'release', 'download', 'v' + INPUTS['prometheus_plugin_version'],
         '--repo', 'grafana/grafana-prometheus-datasource', '--pattern',
         'prometheus-' + INPUTS['prometheus_plugin_version'] + '.linux_amd64.zip', '--dir', OUT])
    archive = OUT / ('prometheus-' + INPUTS['prometheus_plugin_version'] + '.linux_amd64.zip')
    write('plugin-verification.json', verify_plugin(archive, SOURCE, OUT / 'context/prometheus'))


def build():
    version = subprocess.check_output(['go', 'version'], text=True)
    if 'go' + INPUTS['go_version'] + ' ' not in version:
        raise RuntimeError('Unexpected Go compiler: ' + version)
    run(['go', 'mod', 'download'], cwd=SOURCE)
    run(['go', 'mod', 'verify'], cwd=SOURCE)
    selected = json.loads(subprocess.check_output(
        ['go', 'list', '-m', '-json', 'github.com/getkin/kin-openapi'], cwd=SOURCE))
    if selected['Version'] != INPUTS['kin_openapi'] or 'Replace' in selected:
        raise RuntimeError('Patched kin-openapi was not selected in the complete workspace')
    # Upstream's APIs.guru test downloads a fixture into its own testdata tree.
    # Keep Go's verified module cache immutable and run the complete affected
    # package suites in a writable copy of that checksum-verified module.
    dependency_tests = ROOT / 'kin-openapi-tests'
    shutil.copytree(selected['Dir'], dependency_tests)
    for path in [dependency_tests, *dependency_tests.rglob('*')]:
        path.chmod(path.stat().st_mode | stat.S_IWUSR)
    run(['go', 'test', './openapi3', './openapi3filter'], cwd=dependency_tests,
        env={**os.environ, 'GOWORK': 'off'})
    run(['go', 'test', './pkg/api/routing', './pkg/plugins/manager/signature'], cwd=SOURCE)
    run(['make', 'build-go', 'GO=go', 'OS=linux', 'ARCH=amd64'], cwd=SOURCE)
    run(['go', 'mod', 'verify'], cwd=SOURCE)
    shutil.copy2(SOURCE / 'bin/linux/amd64/grafana', OUT / 'context/grafana')
    for name in ['go.mod', 'go.sum', 'go.work', 'go.work.sum']:
        shutil.copy2(SOURCE / name, OUT / name)
    run(['docker', 'build', '--platform', 'linux/amd64', '-f',
         ROOT / 'infra/security/grafana-security.Dockerfile', '--build-arg',
         'UPSTREAM_IMAGE=' + INPUTS['upstream_image'], '--build-arg',
         'HELIX_COMMIT=' + os.environ['GITHUB_SHA'], '-t', IMAGE, OUT / 'context'])
    # This private runner has just built the local tag. The inventory, scan and
    # publication all bind to its recorded image ID; production uses a digest.
    info = json.loads(subprocess.check_output(['docker', 'image', 'inspect', IMAGE]))[0]
    spec = importlib.util.spec_from_file_location('runtime_inspector', ROOT / 'infra/scripts/inspect-grafana-runtime.py')
    inspector = importlib.util.module_from_spec(spec); spec.loader.exec_module(inspector)
    inventory = inspector.inspect(IMAGE, 'go', str(OUT))
    write('runtime-modules.json', inventory)
    main = [b for b in inventory['go_binaries'] if b['path'] == 'usr/share/grafana/bin/grafana'][0]
    if (main['build_info']['GoVersion'] != 'go' + INPUTS['go_version']
            or len(main['kin_openapi']) != 1
            or main['kin_openapi'][0]['Version'] != INPUTS['kin_openapi']
            or 'Replace' in main['kin_openapi'][0]):
        raise RuntimeError('Actual Grafana binary does not contain the reviewed dependency/compiler')
    if len(inventory['go_binaries']) != 2:
        raise RuntimeError('Unexpected additional Go executables in Grafana image')
    write('image-identity.json', {'image_id': info['Id'], 'source_commit': os.environ['GITHUB_SHA']})


def resume():
    """Reuse only the exact successfully tested backend; requalify the new image."""
    retained = json.loads((ROOT / 'infra/security/grafana-backend-resume.json').read_text())
    prefix = 'repos/hamidrezab971-stack/helix/'
    def api(path):
        return json.loads(subprocess.check_output(['gh', 'api', prefix + path]))
    def old_file(path):
        response = api('contents/' + path + '?ref=' + retained['commit'])
        return base64.b64decode(response['content'])
    metadata = api('actions/runs/' + str(retained['run_id']))
    if (metadata['head_sha'] != retained['commit'] or metadata['event'] != 'push'
            or metadata['path'] != '.github/workflows/grafana-security.yml'):
        raise RuntimeError('Retained build workflow identity mismatch')
    jobs = api('actions/runs/' + str(retained['run_id']) + '/jobs')['jobs']
    steps = next(j for j in jobs if j['name'] == 'qualify')['steps']
    tested = next(s for s in steps if s['name'] == 'Test upstream dependency and routing, build patched backend, inspect every ELF')
    if tested['conclusion'] != 'success':
        raise RuntimeError('Retained backend did not pass upstream tests, compilation and ELF inspection')
    old_inputs = json.loads(old_file('infra/security/grafana-build-inputs.json'))
    for key in ['grafana_source', 'grafana_version', 'go_version', 'kin_openapi']:
        if old_inputs[key] != INPUTS[key]:
            raise RuntimeError('Backend input changed; remove resume manifest and compile again')
    if old_file('infra/security/grafana.patch') != (ROOT / 'infra/security/grafana.patch').read_bytes():
        raise RuntimeError('Backend patch changed; a fresh compilation is required')
    def backend_ast(source):
        return ast.dump(next(n for n in ast.parse(source).body
                             if isinstance(n, ast.FunctionDef) and n.name == 'build'), include_attributes=False)
    if backend_ast(old_file('infra/scripts/grafana-delivery.py')) != backend_ast(Path(__file__).read_bytes()):
        raise RuntimeError('Backend build/test procedure changed; a fresh compilation is required')
    artifact = api('actions/artifacts/' + str(retained['artifact_id']))
    if (artifact['digest'] != 'sha256:' + retained['artifact_sha256'] or artifact['expired']
            or artifact['workflow_run']['id'] != retained['run_id']):
        raise RuntimeError('Retained Actions artifact identity mismatch')
    cache = ROOT / 'resume-cache'; cache.mkdir(exist_ok=False)
    archive = cache / 'source.zip'
    with archive.open('wb') as stream:
        run(['gh', 'api', prefix + 'actions/artifacts/' + str(retained['artifact_id']) + '/zip'], stdout=stream)
    if sha(archive) != retained['artifact_sha256']:
        raise RuntimeError('Retained Actions archive checksum mismatch')
    with zipfile.ZipFile(archive) as z:
        for name in ['grafana-image.tar', 'runtime-modules.json', 'image-identity.json',
                     'go.mod', 'go.sum', 'go.work', 'go.work.sum', 'security-summary.json']:
            with z.open(name) as source, (cache / name).open('wb') as target:
                shutil.copyfileobj(source, target)
    previous = json.loads((cache / 'runtime-modules.json').read_text())
    previous_identity = json.loads((cache / 'image-identity.json').read_text())
    if previous_identity['source_commit'] != retained['commit']:
        raise RuntimeError('Retained image source identity mismatch')
    run(['docker', 'load', '-i', cache / 'grafana-image.tar'])
    loaded = json.loads(subprocess.check_output(['docker', 'image', 'inspect', IMAGE]))[0]
    if loaded['Id'] != previous_identity['image_id']:
        raise RuntimeError('Loaded retained image identity mismatch')
    cid = subprocess.check_output(['docker', 'create', '--network', 'none', '--entrypoint',
                                   '/__never_execute__', IMAGE], text=True).strip()
    try:
        run(['docker', 'cp', cid + ':/usr/share/grafana/bin/grafana', OUT / 'context/grafana'])
    finally:
        run(['docker', 'rm', cid], stdout=subprocess.DEVNULL)
    main = next(b for b in previous['go_binaries'] if b['path'] == 'usr/share/grafana/bin/grafana')
    if sha(OUT / 'context/grafana') != main['sha256']:
        raise RuntimeError('Retained tested backend checksum mismatch')
    for name in ['go.mod', 'go.sum', 'go.work', 'go.work.sum']:
        shutil.copy2(cache / name, OUT / name)
    write('backend-resume-verification.json', {**retained, 'upstream_tests_passed': True,
        'backend_procedure_and_inputs_unchanged': True, 'backend_sha256': main['sha256'],
        'prior_scan': json.loads((cache / 'security-summary.json').read_text()),
        'new_complete_image_scan_required': True})
    shutil.rmtree(cache)
    run(['docker', 'build', '--platform', 'linux/amd64', '-f',
         ROOT / 'infra/security/grafana-security.Dockerfile', '--build-arg',
         'UPSTREAM_IMAGE=' + INPUTS['upstream_image'], '--build-arg',
         'HELIX_COMMIT=' + os.environ['GITHUB_SHA'], '-t', IMAGE, OUT / 'context'])
    spec = importlib.util.spec_from_file_location('runtime_inspector', ROOT / 'infra/scripts/inspect-grafana-runtime.py')
    inspector = importlib.util.module_from_spec(spec); spec.loader.exec_module(inspector)
    inventory = inspector.inspect(IMAGE, 'go', str(OUT))
    expected = {b['path']: b['sha256'] for b in previous['go_binaries']}
    actual = {b['path']: b['sha256'] for b in inventory['go_binaries']}
    if actual != expected:
        raise RuntimeError('Repackaging changed a previously inspected Go executable')
    write('runtime-modules.json', inventory)
    info = json.loads(subprocess.check_output(['docker', 'image', 'inspect', IMAGE]))[0]
    write('image-identity.json', {'image_id': info['Id'], 'source_commit': os.environ['GITHUB_SHA'],
                                'backend_build_commit': retained['commit']})


def scan():
    cache = OUT / 'trivy-cache'; cache.mkdir(exist_ok=True)
    base = ['docker', 'run', '--rm', '--mount', f'type=bind,src={OUT},dst=/scan', INPUTS['scanner']]
    run(base + ['image', '--cache-dir', '/scan/trivy-cache', '--download-db-only',
                '--db-repository', INPUTS['database_repository']])
    metadata = json.loads((cache / 'db/metadata.json').read_text())
    age = (datetime.now(timezone.utc) - datetime.fromisoformat(metadata['UpdatedAt'].replace('Z', '+00:00'))).total_seconds()
    if not 0 <= age <= 86400:
        raise RuntimeError('Vulnerability database is stale or future dated')
    write('scanner-database.json', metadata)
    run(['docker', 'save', '-o', OUT / 'grafana-image.tar', IMAGE])
    run(base + ['image', '--input', '/scan/grafana-image.tar', '--cache-dir', '/scan/trivy-cache',
                '--skip-db-update', '--scanners', 'vuln', '--list-all-pkgs', '--ignorefile', '/dev/null',
                '--ignore-unfixed=false', '--exit-code', '0', '--timeout', '10m',
                '--format', 'json', '--output', '/scan/grafana-scan.json'])
    spec = importlib.util.spec_from_file_location('security_gate', ROOT / 'infra/scripts/security-gate.py')
    gate = importlib.util.module_from_spec(spec); spec.loader.exec_module(gate)
    summary = gate.summarize(OUT / 'grafana-scan.json')
    if summary['image_id'] != json.loads((OUT / 'image-identity.json').read_text())['image_id']:
        raise RuntimeError('Scan identity does not match built image')
    write('security-summary.json', summary)
    raw = json.loads((OUT / 'grafana-scan.json').read_text())
    remaining = [{'target': row['Target'], 'id': v['VulnerabilityID'],
                  'severity': v['Severity'], 'package': v['PkgName'],
                  'installed': v['InstalledVersion'], 'fixed': v.get('FixedVersion'),
                  'status': v.get('Status'), 'url': v.get('PrimaryURL')}
                 for row in raw['Results'] for v in row.get('Vulnerabilities', [])]
    write('remaining-findings.json', remaining)
    print(json.dumps({'all_remaining_findings': remaining}, indent=2))
    print(json.dumps(summary, indent=2))
    if summary['high_critical_package_findings']:
        raise RuntimeError('Unsuppressed Grafana HIGH/CRITICAL security gate failed')


def smoke():
    password = secrets.token_urlsafe(32)
    cid = subprocess.check_output(['docker', 'run', '-d', '--read-only', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges', '--memory', '1g', '--cpus', '2',
        '--tmpfs', '/var/lib/grafana:uid=472,gid=472', '--tmpfs', '/var/log/grafana:uid=472,gid=472',
        '--tmpfs', '/tmp', '-p', '127.0.0.1::3000', '-e', 'GF_SECURITY_ADMIN_USER=helix-ci',
        '-e', 'GF_SECURITY_ADMIN_PASSWORD=' + password, '-e', 'GF_PLUGINS_PREINSTALL_DISABLED=true',
        '-e', 'GF_ANALYTICS_REPORTING_ENABLED=false', IMAGE], text=True).strip()
    try:
        port = json.loads(subprocess.check_output(['docker', 'inspect', cid]))[0]['NetworkSettings']['Ports']['3000/tcp'][0]['HostPort']
        url = 'http://127.0.0.1:' + port
        for _ in range(120):
            try:
                health = json.load(urllib.request.urlopen(url + '/api/health', timeout=2))
                if health.get('database') == 'ok': break
            except (urllib.error.URLError, TimeoutError, ConnectionError): pass
            time.sleep(1)
        else: raise RuntimeError('Grafana did not become healthy')
        request = urllib.request.Request(url + '/api/plugins/prometheus/settings',
            headers={'Authorization': 'Basic ' + base64.b64encode(('helix-ci:' + password).encode()).decode()})
        plugin = json.load(urllib.request.urlopen(request, timeout=15))
        write('runtime-plugin.json', plugin)
        if plugin.get('signature') != 'valid' or plugin.get('signatureType') != 'grafana':
            raise RuntimeError('Grafana did not validate the publisher plugin signature')
        write('runtime-smoke.json', {'health': health, 'publisher_plugin_signature_valid': True})
    finally:
        (OUT / 'runtime.log').write_bytes(subprocess.check_output(['docker', 'logs', cid], stderr=subprocess.STDOUT))
        run(['docker', 'rm', '-f', cid], stdout=subprocess.DEVNULL)
    provenance = {'inputs': INPUTS, 'helix_commit': os.environ['GITHUB_SHA'],
                  'workflow_run': os.environ['GITHUB_SERVER_URL'] + '/' + os.environ['GITHUB_REPOSITORY'] + '/actions/runs/' + os.environ['GITHUB_RUN_ID'],
                  'upstream_image_publisher_signature_claimed': False,
                  'qualification': 'tested HELIX source rebuild with verified Grafana publisher plugin',
                  'files': {p.name: sha(p) for p in OUT.iterdir() if p.is_file()}}
    write('provenance.json', provenance)
    write('release-qualified.json', {'qualified': True, 'source_commit': os.environ['GITHUB_SHA'],
                                    'image_id': json.loads((OUT / 'image-identity.json').read_text())['image_id'],
                                    'provenance_sha256': sha(OUT / 'provenance.json')})


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('stage', choices=['prepare', 'build', 'resume', 'scan', 'smoke'])
    globals()[parser.parse_args().stage]()
