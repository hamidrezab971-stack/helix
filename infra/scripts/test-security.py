#!/usr/bin/env python3
"""Release gate and protected credential failure modes, without Docker or secrets."""
import fcntl
import hashlib
import io
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import tarfile
import time
import unittest

ROOT = Path(__file__).resolve().parent
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module

auth = load('retained_auth', ROOT / 'verify-retained-auth.py')
oci = load('image_archive', ROOT / 'image_archive.py')
application = load('application_gate', ROOT / 'application-security-gate.py')


class SecurityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.report = {'SchemaVersion': 2, 'Metadata': {'ImageID': 'sha256:' + 'a' * 64},
                       'Results': [{'Target': 'runtime', 'Packages': [], 'Vulnerabilities': []}]}

    def run_gate(self, vulnerability=None):
        for service in ('app', 'prometheus', 'grafana', 'node-exporter'):
            report = json.loads(json.dumps(self.report))
            if vulnerability and service == 'grafana':
                report['Results'][0]['Vulnerabilities'] = [vulnerability]
            (self.root / (service + '.json')).write_text(json.dumps(report))
        return subprocess.run([sys.executable, str(ROOT / 'security-gate.py'),
                               '--reports', str(self.root), '--output', str(self.root / 'summary.json')],
                              capture_output=True, text=True)

    def test_fixable_high_still_blocks_release(self):
        result = self.run_gate({'Severity': 'HIGH', 'VulnerabilityID': 'CVE-test',
                               'PkgName': 'module', 'InstalledVersion': '1.0', 'FixedVersion': '1.1'})
        self.assertEqual(result.returncode, 1)
        summary = json.loads((self.root / 'summary.json').read_text())
        self.assertEqual(summary['decision'], 'NO-GO')
        self.assertEqual(summary['services']['grafana']['fixable_high_critical'], 1)

    def test_no_fix_critical_still_blocks_release(self):
        result = self.run_gate({'Severity': 'CRITICAL', 'VulnerabilityID': 'CVE-test',
                               'PkgName': 'module', 'InstalledVersion': '1.0'})
        self.assertEqual(result.returncode, 1)

    def test_zero_findings_cannot_claim_runtime_readiness(self):
        self.assertEqual(self.run_gate().returncode, 0)
        report = json.loads((self.root / 'summary.json').read_text())
        self.assertEqual(report['decision'], 'SECURITY_COUNTS_PASS_ONLY')
        self.assertTrue(report['runtime_qualification_required'])

    def test_incomplete_analysis_never_becomes_green(self):
        self.report['Results'] = []
        self.assertNotEqual(self.run_gate().returncode, 0)
        self.assertFalse((self.root / 'summary.json').exists())

    def application_fixture(self):
        from datetime import datetime, timezone
        self.report['Results'][0]['Vulnerabilities'] = [{
            'Severity': 'HIGH', 'VulnerabilityID': 'CVE-2026-9538',
            'PkgName': 'perl-base', 'InstalledVersion': '1'}]
        path = self.root/'app.json'; path.write_text(json.dumps(self.report))
        image = 'example@sha256:' + 'b'*64
        review = {'image': image, 'config_id': self.report['Metadata']['ImageID'],
                  'report_sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                  'findings': [{'target': 'runtime', 'id': 'CVE-2026-9538',
                    'package': 'perl-base', 'installed': '1', 'severity': 'HIGH',
                    'disposition': 'not_affected_in_qualified_runtime',
                    'rationale': 'Affected module absent', 'source': 'https://example.test/advisory'}]}
        provenance = {'images': {'app': {'reference': image, 'config_id': review['config_id']}},
                      'database': {'UpdatedAt': datetime.now(timezone.utc).isoformat()}}
        return path, review, provenance

    def test_application_gate_rejects_changed_scan(self):
        path, review, provenance = self.application_fixture()
        path.write_text(path.read_text()+'\n')
        with self.assertRaisesRegex(RuntimeError, 'Scan changed'):
            application.qualify(path, review, provenance, self.root)

    def test_application_gate_rejects_missing_row_review(self):
        path, review, provenance = self.application_fixture(); review['findings'] = []
        with self.assertRaisesRegex(RuntimeError, 'Incomplete individual review'):
            application.qualify(path, review, provenance, self.root)

    def test_application_gate_rejects_risk_acceptance(self):
        path, review, provenance = self.application_fixture()
        review['findings'][0]['disposition'] = 'risk_accepted'
        with self.assertRaisesRegex(RuntimeError, 'risk blocks release'):
            application.qualify(path, review, provenance, self.root)

    def test_application_gate_rejects_mismatched_image(self):
        path, review, provenance = self.application_fixture()
        provenance['images']['app']['config_id'] = 'sha256:'+'c'*64
        with self.assertRaisesRegex(RuntimeError, 'Scan/artifact mismatch'):
            application.qualify(path, review, provenance, self.root)

    def test_echoed_or_piped_credential_input_is_refused(self):
        if not sys.stdin.isatty():
            with self.assertRaises(RuntimeError): auth.hidden_input()

    def test_oci_index_is_distinct_from_scanner_config_identity(self):
        blobs = {}
        def blob(value, **extra):
            data = json.dumps(value).encode(); digest = 'sha256:' + hashlib.sha256(data).hexdigest()
            blobs['blobs/' + digest.replace(':', '/')] = data
            return {'digest': digest, 'size': len(data), **extra}
        config = blob({'architecture': 'amd64', 'os': 'linux'})
        manifest = blob({'config': config, 'layers': []},
                        platform={'os': 'linux', 'architecture': 'amd64'})
        index = blob({'manifests': [manifest]})
        blobs['index.json'] = json.dumps({'manifests': [index]}).encode()
        path = self.root / 'image.tar'
        def save():
            with tarfile.open(path, 'w') as t:
                for name, data in blobs.items():
                    member = tarfile.TarInfo(name); member.size = len(data)
                    t.addfile(member, io.BytesIO(data))
        save()
        checked = oci.identity(path, index['digest'])
        self.assertEqual(checked['config_id'], config['digest'])
        self.assertNotEqual(checked['reference_digest'], checked['config_id'])
        with self.assertRaises(ValueError): oci.identity(path, 'sha256:' + '0' * 64)
        blobs['blobs/' + config['digest'].replace(':', '/')] = b'tampered'
        save()
        with self.assertRaises(ValueError): oci.identity(path, index['digest'])

    @unittest.skipUnless(os.geteuid() == 0, 'Established credential protocol requires root')
    def test_sealed_descriptor_and_expiry(self):
        for expired in (False, True):
            fd = os.memfd_create('isolated-security-test', os.MFD_ALLOW_SEALING)
            try:
                os.fchmod(fd, 0o600)
                os.write(fd, json.dumps({'username': 'qa', 'password': 'synthetic-only',
                                        'created_at': time.time() - (7201 if expired else 0)}).encode())
                with self.assertRaises(RuntimeError): auth.credential(fd)
                seals = fcntl.F_SEAL_SEAL | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_GROW | fcntl.F_SEAL_WRITE
                fcntl.fcntl(fd, fcntl.F_ADD_SEALS, seals)
                if expired:
                    with self.assertRaises(RuntimeError): auth.credential(fd)
                else:
                    self.assertEqual(auth.credential(fd)[0], 'qa')
            finally:
                os.close(fd)


if __name__ == '__main__':
    unittest.main(verbosity=2)
