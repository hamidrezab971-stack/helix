#!/usr/bin/env python3
"""Exercise backup/continuity failure modes with actual disposable SQLite files."""
import importlib.util
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('data_safety',ROOT/'scripts/data-safety.py')
safety=importlib.util.module_from_spec(spec);spec.loader.exec_module(safety)
class SafetyTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.data=self.root/'data';self.data.mkdir()
        (self.data/'uploads').mkdir();(self.data/'uploads/opaque').write_bytes(b'actual uploaded bytes')
        self.env=self.root/'app.env';self.env.write_text('SECRET_KEY=isolated-test-key-at-least-32-bytes\n')
        with sqlite3.connect(self.data/'smooth.db') as db:
            db.execute('CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, password_hash TEXT)')
            db.execute('INSERT INTO users VALUES (1, ?, ?)',('private value','retained-hash'))
    def test_verified_snapshot_and_additive_migration_continuity(self):
        target=self.root/'baseline';safety.snapshot(self.data,self.env,target,None)
        self.assertEqual(safety.manifest(target/'uploads'),safety.manifest(self.data/'uploads'))
        self.assertEqual((target/'app.env').read_bytes(),self.env.read_bytes())
        with sqlite3.connect(self.data/'smooth.db') as db:
            db.execute('ALTER TABLE users ADD COLUMN new_field TEXT')
            db.execute('INSERT INTO users (id,username) VALUES (2,?)',('new data',))
        self.assertEqual(safety.compare(target/'smooth.db',self.data/'smooth.db'),{'users':1})
        with self.assertRaises(FileExistsError): safety.snapshot(self.data,self.env,target,None)
    def test_changed_and_deleted_rows_fail_without_values_in_error(self):
        target=self.root/'baseline';safety.snapshot(self.data,self.env,target,None)
        for sql in ("UPDATE users SET username='changed'",'DELETE FROM users'):
            with sqlite3.connect(self.data/'smooth.db') as db: db.execute(sql)
            with self.assertRaises(RuntimeError) as error: safety.compare(target/'smooth.db',self.data/'smooth.db')
            self.assertNotIn('private value',str(error.exception))
    def test_upload_symlinks_are_rejected(self):
        (self.data/'uploads/symlink').symlink_to(self.env)
        with self.assertRaises(RuntimeError): safety.snapshot(self.data,self.env,self.root/'baseline',None)
    def test_snapshot_cannot_recurse_into_its_source(self):
        target=self.data/'uploads/recursive-backup'
        with self.assertRaises(RuntimeError): safety.snapshot(self.data,self.env,target,None)
        self.assertFalse(target.exists())
    def test_snapshot_cannot_follow_a_database_symlink(self):
        original=self.data/'smooth.db'
        original.rename(self.root/'real.db'); original.symlink_to(self.root/'real.db')
        with self.assertRaises(RuntimeError): safety.snapshot(self.data,self.env,self.root/'baseline',None)
        self.assertFalse((self.root/'baseline').exists())
    def test_fresh_marker_survives_backup_and_disposable_restore(self):
        with sqlite3.connect(self.data/'smooth.db') as db: db.execute('DELETE FROM users')
        marker=self.data/'.helix-fresh-bootstrap-v1';marker.write_bytes(b'HELIX fresh bootstrap v1\n');marker.chmod(0o600)
        baseline=self.root/'fresh-backup';safety.snapshot(self.data,self.env,baseline,None)
        work=self.root/'restored'
        result=subprocess.run([sys.executable,str(ROOT/'scripts/prepare-rehearsal.py'),'--baseline',str(baseline),'--output',str(work)],capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual((work/'data/.helix-fresh-bootstrap-v1').read_bytes(),marker.read_bytes())
        self.assertEqual((work/'data/.helix-fresh-bootstrap-v1').stat().st_mode & 0o077,0)
    def test_snapshot_refuses_a_symlink_bootstrap_marker(self):
        (self.data/'.helix-fresh-bootstrap-v1').symlink_to(self.env)
        with self.assertRaisesRegex(RuntimeError,'Invalid fresh bootstrap marker'):
            safety.snapshot(self.data,self.env,self.root/'unsafe-marker',None)
        self.assertFalse((self.root/'unsafe-marker').exists())
    def test_empty_account_table_is_rejected_without_migrations(self):
        with sqlite3.connect(self.data/'smooth.db') as db: db.execute('DELETE FROM users')
        before=(self.data/'smooth.db').read_bytes()
        r=self.entrypoint(self.data/'smooth.db')
        self.assertNotEqual(r.returncode,0);self.assertIn('refusing empty initialization',r.stderr)
        self.assertEqual((self.data/'smooth.db').read_bytes(),before)
    def test_incomplete_bootstrap_marker_cannot_authorize_empty_storage(self):
        with sqlite3.connect(self.data/'smooth.db') as db: db.execute('DELETE FROM users')
        marker=self.data/'.helix-fresh-bootstrap-v1';marker.write_bytes(b'incomplete')
        marker.chmod(0o600)
        before=(self.data/'smooth.db').read_bytes()
        r=self.entrypoint(self.data/'smooth.db')
        self.assertIn('refusing empty initialization',r.stderr)
        self.assertEqual((self.data/'smooth.db').read_bytes(),before)
    def test_symlink_bootstrap_marker_cannot_authorize_empty_storage(self):
        with sqlite3.connect(self.data/'smooth.db') as db: db.execute('DELETE FROM users')
        source=self.root/'marker';source.write_bytes(b'HELIX fresh bootstrap v1\n');source.chmod(0o600)
        (self.data/'.helix-fresh-bootstrap-v1').symlink_to(source)
        self.assertIn('refusing empty initialization',self.entrypoint(self.data/'smooth.db').stderr)
    def test_completed_marker_never_recreates_a_missing_database(self):
        (self.data/'smooth.db').unlink()
        marker=self.data/'.helix-fresh-bootstrap-v1';marker.write_bytes(b'HELIX fresh bootstrap v1\n')
        marker.chmod(0o600)
        self.assertIn('refusing empty initialization',self.entrypoint(self.data/'smooth.db').stderr)
        self.assertFalse((self.data/'smooth.db').exists())
    @unittest.skipUnless(os.geteuid()==0 or os.getegid()==0,'Root rejection applies only to a root test runner')
    def test_explicit_fresh_bootstrap_refuses_root_without_creating_database(self):
        (self.data/'smooth.db').unlink()
        r=subprocess.run([sys.executable,str(ROOT/'scripts/container-entrypoint.py'),'--initialize-empty'],env={**os.environ,'DATABASE_URL':'sqlite:///'+str(self.data/'smooth.db'),'UPLOAD_DIR':str(self.data/'uploads')},capture_output=True,text=True)
        self.assertIn('non-root runtime',r.stderr)
        self.assertFalse((self.data/'smooth.db').exists())
    def entrypoint(self,path):
        return subprocess.run([sys.executable,str(ROOT/'scripts/container-entrypoint.py')],env={**os.environ,'DATABASE_URL':'sqlite:///'+str(path),'UPLOAD_DIR':str(self.data/'uploads')},capture_output=True,text=True)
    def test_zero_byte_database_is_rejected_unchanged(self):
        path=self.root/'empty.db';path.touch()
        self.assertIn('refusing empty initialization',self.entrypoint(path).stderr)
        self.assertEqual(path.stat().st_size,0)
    def test_entrypoint_rejects_symlink_to_valid_database(self):
        path=self.root/'link.db';path.symlink_to(self.data/'smooth.db')
        self.assertIn('symbolic links',self.entrypoint(path).stderr)
    def test_entrypoint_rejects_foreign_key_corruption(self):
        with sqlite3.connect(self.data/'smooth.db') as db:
            db.execute('CREATE TABLE children (parent INTEGER REFERENCES users(id))')
            db.execute('INSERT INTO children VALUES (99)')
        self.assertIn('foreign_key_check failed',self.entrypoint(self.data/'smooth.db').stderr)
    def test_production_snapshot_requires_quiescence(self):
        with self.assertRaises(RuntimeError): safety.snapshot(Path('/var/lib/helix'),self.env,self.root/'baseline',None)
    def test_online_rehearsal_is_labelled_and_cannot_claim_quiescence(self):
        target=self.root/'online'
        safety.snapshot(self.data,self.env,target,None,online_rehearsal=True)
        import json
        report=json.loads((target/'snapshot.json').read_text())
        self.assertTrue(report['online_rehearsal'])
        self.assertFalse(report['cutover_backup'])
        with self.assertRaises(RuntimeError):
            safety.snapshot(self.data,self.env,self.root/'invalid','helix.service',online_rehearsal=True)
    def test_entrypoint_refuses_empty_database_without_creating_one(self):
        nonexistent=self.root/'absent.db'
        r=subprocess.run([sys.executable,str(ROOT/'scripts/container-entrypoint.py')],env={**os.environ,'DATABASE_URL':'sqlite:///'+str(nonexistent),'UPLOAD_DIR':str(self.data/'uploads')},capture_output=True,text=True)
        self.assertNotEqual(r.returncode,0);self.assertIn('refusing empty initialization',r.stderr)
        self.assertFalse(nonexistent.exists())
    def test_corrupt_database_fails_integrity(self):
        (self.data/'smooth.db').write_bytes(b'corrupt database')
        with self.assertRaises(sqlite3.DatabaseError): safety.snapshot(self.data,self.env,self.root/'baseline',None)
    @unittest.skipUnless(os.geteuid()==0 or os.getegid()==0,'Root rejection applies only to a root test runner')
    def test_entrypoint_refuses_root_with_valid_existing_database(self):
        r=subprocess.run([sys.executable,str(ROOT/'scripts/container-entrypoint.py')],env={**os.environ,'DATABASE_URL':'sqlite:///'+str(self.data/'smooth.db'),'UPLOAD_DIR':str(self.data/'uploads')},capture_output=True,text=True)
        self.assertNotEqual(r.returncode,0);self.assertIn('non-root runtime',r.stderr)
if __name__=='__main__': unittest.main(verbosity=2)
