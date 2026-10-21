#!/usr/bin/env python3
"""Qualify an exact reviewed application artifact; retain raw scanner failures.

This separate gate never changes the all-service raw severity gate. Each High
and Critical must have an exact, evidence-bound non-applicability review.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess


PROBE = r'''
import os,pathlib,json,subprocess,hashlib
status=dict(line.split(':',1) for line in pathlib.Path('/proc/self/status').read_text().splitlines() if ':' in line)
suid=[]
for root,dirs,files in os.walk('/'):
 dirs[:]=[d for d in dirs if str(pathlib.Path(root)/d) not in ['/proc','/sys','/dev']]
 for f in files:
  q=pathlib.Path(root)/f
  try:
   if q.is_file() and q.stat().st_mode & 0o6000:suid.append(str(q))
  except OSError:pass
print(json.dumps({'uid':os.getuid(),'gid':os.getgid(),
 'status':{k:status[k].strip() for k in ['CapInh','CapPrm','CapEff','CapBnd','CapAmb','NoNewPrivs','Seccomp']},
 'suid_sgid':suid,
 'fstab_entries':[x for x in pathlib.Path('/etc/fstab').read_text().splitlines() if x.strip() and not x.lstrip().startswith('#')],
 'infocmp_present':any(pathlib.Path(x).exists() for x in ['/usr/bin/infocmp','/bin/infocmp']),
 'homed_present':any(pathlib.Path(x).exists() for x in ['/usr/lib/systemd/systemd-homed','/lib/systemd/systemd-homed']),
 'archive_tar_load_exit':subprocess.run(['perl','-MArchive::Tar','-e','exit 0'],capture_output=True).returncode,
 'libacl_mapped':'libacl.so' in pathlib.Path('/proc/self/maps').read_text(),
 'modules':{str(q):hashlib.sha256(q.read_bytes()).hexdigest() for q in pathlib.Path('/app/backend/app').rglob('*') if q.is_file()},
 'entrypoint_sha256':hashlib.sha256(pathlib.Path('/app/container-entrypoint.py').read_bytes()).hexdigest(),
 'frontend_sha256':hashlib.sha256(pathlib.Path('/app/frontend/dist/index.html').read_bytes()).hexdigest()}))
'''


def require(value, message):
    if not value:
        raise RuntimeError(message)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def qualify(report, review, provenance, root):
    raw = json.loads(report.read_text())
    require(raw.get('SchemaVersion') == 2 and raw.get('Results'), 'Incomplete scan')
    require(digest(report) == review['report_sha256'], 'Scan changed: new review required')
    image = provenance['images']['app']
    require(image['reference'] == review['image'], 'Image outside reviewed scope')
    require(raw['Metadata']['ImageID'] == image['config_id'] == review['config_id'], 'Scan/artifact mismatch')
    updated = datetime.fromisoformat(provenance['database']['UpdatedAt'].replace('Z', '+00:00'))
    require(0 <= (datetime.now(timezone.utc) - updated).total_seconds() <= 86400, 'Stale database')
    findings = []
    for row in raw['Results']:
        require('Vulnerabilities' in row or 'Packages' in row, 'Missing analysis')
        for v in row.get('Vulnerabilities', []):
            if v['Severity'] in ('HIGH', 'CRITICAL'):
                findings.append((row['Target'], v['VulnerabilityID'], v['PkgName'], v['InstalledVersion'], v['Severity']))
    assessed = review['findings']
    keys = [(v['target'], v['id'], v['package'], v['installed'], v['severity']) for v in assessed]
    require(len(set(keys)) == len(keys) and sorted(keys) == sorted(findings), 'Incomplete individual review')
    require(all(v['disposition'] == 'not_affected_in_qualified_runtime' and v['rationale'] and v['source'] for v in assessed),
            'Reachable, accepted or unverified application risk blocks release')
    require({v['id'] for v in assessed} <= {
        'CVE-2026-76642', 'CVE-2026-78408', 'CVE-2026-78409', 'CVE-2026-78410',
        'CVE-2026-54369', 'CVE-2025-69720', 'CVE-2026-16742', 'CVE-2026-9538'}, 'Unqualified CVE')
    result = subprocess.run(['docker', 'run', '--rm', '--network', 'none', '--read-only',
        '--user', '10001:10001', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '--memory', '384m', '--pids-limit', '128', '--entrypoint', 'python', review['image'], '-c', PROBE],
        check=True, capture_output=True, text=True, timeout=90)
    proof = json.loads(result.stdout)
    require(proof['uid'] == proof['gid'] == 10001, 'Non-root identity required')
    require(all(proof['status'][k] == '0000000000000000' for k in ('CapInh','CapPrm','CapEff','CapBnd','CapAmb')), 'Capabilities present')
    require(proof['status']['NoNewPrivs'] == '1' and proof['status']['Seccomp'] == '2', 'Confinement missing')
    require(not any(proof[k] for k in ('suid_sgid','fstab_entries','infocmp_present','homed_present','libacl_mapped')),
            'Required component/privilege exclusion failed')
    require(proof['archive_tar_load_exit'] != 0, 'Archive::Tar unexpectedly present')
    kernel = subprocess.check_output(['uname', '-r'], text=True).strip()
    require(tuple(map(int, kernel.split('-')[0].split('.')[:2])) < (6, 15), 'Mount fast-path review invalid on this kernel')
    proof['kernel'] = kernel
    for file, sha in proof['modules'].items():
        require(digest(root/'smooth/backend'/Path(file).relative_to('/app/backend')) == sha, 'Application source drift')
    require(proof['entrypoint_sha256'] == digest(root/'infra/scripts/container-entrypoint.py'), 'Entrypoint drift')
    return {'decision': 'PASS — REVIEWED APPLICATION SECURITY', 'image': review['image'],
            'report_sha256': digest(report), 'reviewed_high_critical_rows': len(findings),
            'raw_scanner_findings_preserved': True, 'material_risk_accepted': False,
            'proof': proof, 'at': datetime.now(timezone.utc).isoformat()}


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--report', type=Path, required=True)
    p.add_argument('--provenance', type=Path, required=True)
    p.add_argument('--review', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    a = p.parse_args()
    result = qualify(a.report, json.loads(a.review.read_text()), json.loads(a.provenance.read_text()), Path(__file__).resolve().parents[2])
    with a.output.open('x') as f:
        json.dump(result, f, indent=2); f.write('\n')
    print(json.dumps({k:v for k,v in result.items() if k != 'proof'}, indent=2))
