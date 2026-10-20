#!/usr/bin/env python3
"""Summarize all four raw Trivy reports without suppressions; High/Critical fail."""
import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path

SERVICES = ('app', 'prometheus', 'grafana', 'node-exporter')


def summarize(path):
    data = json.loads(path.read_text())
    if data.get('SchemaVersion') != 2 or not data.get('Metadata', {}).get('ImageID'):
        raise ValueError('Complete Trivy image report required')
    if not data.get('Results') or any('Vulnerabilities' not in row and 'Packages' not in row
                                      for row in data['Results']):
        raise ValueError('Missing vulnerability analysis results')
    findings = [v for row in data['Results'] for v in row.get('Vulnerabilities', [])]
    counts = Counter(v['Severity'] for v in findings)
    high = []
    for row in data['Results']:
        for v in row.get('Vulnerabilities', []):
            if v['Severity'] in ('HIGH', 'CRITICAL'):
                high.append({
                    'id': v['VulnerabilityID'], 'severity': v['Severity'],
                    'target': row['Target'], 'class': row.get('Class'),
                    'package': v['PkgName'], 'installed': v['InstalledVersion'],
                    'fixed': v.get('FixedVersion'), 'status': v.get('Status'),
                    'description': v.get('Description'), 'source': v.get('DataSource'),
                    'url': v.get('PrimaryURL'), 'references': v.get('References', []),
                })
    return {
        'report_sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
        'scan_created_at': data.get('CreatedAt'),
        'image_id': data['Metadata']['ImageID'], 'counts': dict(counts),
        'high_critical_package_findings': len(high),
        'high_critical_unique_cves': len({v['id'] for v in high}),
        'fixable_high_critical': sum(bool(v['fixed']) for v in high),
        'findings': high,
    }


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--reports', type=Path, required=True,
                   help='app.json, prometheus.json, grafana.json, node-exporter.json')
    p.add_argument('--output', type=Path, required=True)
    a = p.parse_args()
    services = {s: summarize(a.reports / (s + '.json')) for s in SERVICES}
    blocked = any(s['high_critical_package_findings'] for s in services.values())
    report = {'generated_at': datetime.now(timezone.utc).isoformat(),
              'decision': 'NO-GO' if blocked else 'SECURITY_COUNTS_PASS_ONLY',
              'runtime_qualification_required': True, 'services': services}
    with a.output.open('x') as f:
        json.dump(report, f, indent=2); f.write('\n')
    print(json.dumps({s: {k: v[k] for k in ('counts', 'high_critical_unique_cves',
                                          'fixable_high_critical')}
                      for s, v in services.items()}, indent=2))
    raise SystemExit(1 if blocked else 0)


if __name__ == '__main__':
    main()
