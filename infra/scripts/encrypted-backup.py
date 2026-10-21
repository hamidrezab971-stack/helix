#!/usr/bin/env python3
"""Create and restore-check a private production backup; never uploads or restores live."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import sqlite3
import subprocess
import tarfile
import tempfile


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def run(args, **kwargs):
    return subprocess.run(list(map(str, args)), check=True, timeout=600, **kwargs)


def database_check(path):
    with sqlite3.connect(path.as_uri() + '?mode=ro', uri=True) as db:
        if db.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
            raise RuntimeError('SQLite integrity check failed')
        if db.execute('PRAGMA foreign_key_check').fetchall():
            raise RuntimeError('SQLite foreign key check failed')
        tables = [r[0] for r in db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
        return {t: db.execute('SELECT count(*) FROM "' + t.replace('"', '""') + '"').fetchone()[0]
                for t in tables}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--passphrase-file', type=Path, required=True)
    a = p.parse_args()
    if os.geteuid() != 0:
        p.error('Root is required for protected recovery configuration')
    os.umask(0o077)
    output = a.output.resolve()
    repo = Path(__file__).resolve().parents[2]
    if output.is_relative_to(repo):
        p.error('Backup must remain outside Git')
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    key = a.passphrase_file.resolve()
    if key.is_relative_to(output) or key.is_relative_to(repo):
        p.error('Keep the recovery key outside both backup and source repository')
    key.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if not key.exists():
        with key.open('x') as stream:
            stream.write(secrets.token_urlsafe(64) + '\n')
    if key.stat().st_mode & 0o077 or len(key.read_bytes().strip()) < 64:
        p.error('A strong recovery secret in a mode 0600 file is required')
    started = datetime.now(timezone.utc).isoformat()
    with tempfile.TemporaryDirectory(prefix='.private-', dir=output) as temp:
        work = Path(temp)
        stage = work / 'payload'
        stage.mkdir(mode=0o700)
        data = stage / 'data'
        data.mkdir(mode=0o700)
        live = Path('/var/lib/helix-docker/data')
        # SQLite's online backup API yields a consistent committed snapshot.
        with sqlite3.connect((live / 'smooth.db').as_uri() + '?mode=ro', uri=True) as src:
            with sqlite3.connect(data / 'smooth.db') as dst:
                src.backup(dst, pages=256, sleep=0.1)
        counts = database_check(data / 'smooth.db')
        shutil.copytree(live / 'uploads', data / 'uploads', symlinks=False)
        # Upload names are immutable; detect a concurrent deletion/replacement.
        for f in (data / 'uploads').rglob('*'):
            if f.is_file():
                original = live / f.relative_to(data)
                if original.is_symlink() or not original.is_file() or sha(original) != sha(f):
                    raise RuntimeError('Upload changed during snapshot; retry backup')
        with sqlite3.connect(data / 'smooth.db') as db:
            for row in db.execute('SELECT storage_name FROM message_attachments'):
                if not (data / 'uploads/images' / row[0]).is_file():
                    raise RuntimeError('Database snapshot references a missing attachment')
            for row in db.execute('SELECT storage_name FROM user_profile_photos'):
                if not (data / 'uploads/profiles' / row[0]).is_file():
                    raise RuntimeError('Database snapshot references a missing profile photo')
        recovery = stage / 'recovery'
        recovery.mkdir(mode=0o700)
        for source, name in [('/etc/helix', 'helix-config'),
                             ('/etc/nginx', 'nginx'),
                             ('/etc/letsencrypt', 'letsencrypt'),
                             ('/opt/helix-docker-production', 'deployment')]:
            shutil.copytree(source, recovery / name, symlinks=False)
        units = recovery / 'systemd'
        units.mkdir()
        for f in Path('/etc/systemd/system').glob('helix*'):
            if f.is_dir():
                shutil.copytree(f, units / f.name)
            elif f.is_file():
                shutil.copy2(f, units / f.name)
        prior = Path('/root/helix-decoupled-20261021')
        for name in ['release-manifest.json', 'old-systemd-offline.tar.gz', 'grafana-suspended.tar.gz']:
            shutil.copy2(prior / name, recovery / name)
        with (recovery / 'source.tar').open('wb') as stream:
            run(['git', '-C', repo, 'archive', 'HEAD'], stdout=stream)
        images = json.loads(subprocess.check_output(['docker', 'inspect',
            'helix-production-app', 'helix-production-node-exporter-1',
            'helix-production-prometheus-1'], timeout=30))
        refs = {c['Config']['Labels']['com.docker.compose.service']: c['Image'] for c in images}
        for service in ('app', 'node-exporter'):
            # These local publisher artifacts cannot be pulled from a public registry.
            run(['docker', 'image', 'save', '-o', recovery / (service + '-image.tar'), refs[service]])
        (recovery / 'images.json').write_text(json.dumps(refs, indent=2) + '\n')
        manifest = {str(f.relative_to(stage)): sha(f) for f in stage.rglob('*') if f.is_file()}
        (stage / 'MANIFEST.json').write_text(json.dumps(manifest, indent=2) + '\n')
        archive = work / 'payload.tar.gz'
        with tarfile.open(archive, 'w:gz') as tar:
            tar.add(stage, arcname='helix-recovery', recursive=True)
        encrypted = output / 'helix-production.tar.gz.gpg'
        gpg = ['gpg', '--batch', '--no-tty', '--pinentry-mode', 'loopback',
               '--passphrase-file', key]
        run(gpg + ['--symmetric', '--cipher-algo', 'AES256', '--s2k-digest-algo', 'SHA512',
                   '--s2k-mode', '3', '--s2k-count', '65011712', '--compress-algo', 'none',
                   '--output', encrypted, archive], stdout=subprocess.DEVNULL)
        # Test recovery from the ciphertext, rather than from the staging files.
        decrypted = work / 'restored.tar.gz'
        run(gpg + ['--output', decrypted, '--decrypt', encrypted], stdout=subprocess.DEVNULL)
        restored = work / 'restore-check'
        restored.mkdir(mode=0o700)
        with tarfile.open(decrypted, 'r:gz') as tar:
            tar.extractall(restored, filter='data')
        restored = restored / 'helix-recovery'
        expected = json.loads((restored / 'MANIFEST.json').read_text())
        actual = {str(f.relative_to(restored)): sha(f) for f in restored.rglob('*')
                  if f.is_file() and f != restored / 'MANIFEST.json'}
        if actual != expected:
            raise RuntimeError('Restored file checksum manifest does not match')
        if database_check(restored / 'data/smooth.db') != counts:
            raise RuntimeError('Restored database counts differ from snapshot')
        result = {'started_at': started, 'verified_at': datetime.now(timezone.utc).isoformat(),
                  'artifact': str(encrypted), 'sha256': sha(encrypted), 'bytes': encrypted.stat().st_size,
                  'cipher': 'GnuPG AES256 with integrity protection', 'files_verified': len(expected),
                  'sqlite_integrity': 'ok', 'foreign_keys': 'ok', 'snapshot_counts': counts,
                  'image_ids': refs, 'restore_test': 'PASS in isolated temporary directory',
                  'live_restore': False, 'offsite_uploaded': False,
                  'offsite_blocker': 'Authorized destination and separate recovery-key custody required',
                  'retention': 'Keep this verified copy; no automatic deletion before verified offsite copy'}
        (output / 'verification.json').write_text(json.dumps(result, indent=2) + '\n')
        (output / 'SHA256SUMS').write_text(result['sha256'] + '  ' + encrypted.name + '\n')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
