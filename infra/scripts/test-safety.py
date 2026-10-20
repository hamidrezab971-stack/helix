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
            db.execute('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)')
            db.execute('INSERT INTO users VALUES (1, ?)',('private value',))
    def test_verified_snapshot_and_additive_migration_continuity(self):
        target=self.root/'baseline';safety.snapshot(self.data,self.env,target,None)
        self.assertEqual(safety.manifest(target/'uploads'),safety.manifest(self.data/'uploads'))
        self.assertEqual((target/'app.env').read_bytes(),self.env.read_bytes())
        with sqlite3.connect(self.data/'smooth.db') as db:
            db.execute('ALTER TABLE users ADD COLUMN new_field TEXT')
            db.execute('INSERT INTO users (id,name) VALUES (2,?)',('new data',))
        self.assertEqual(safety.compare(target/'smooth.db',self.data/'smooth.db'),{'users':1})
        with self.assertRaises(FileExistsError): safety.snapshot(self.data,self.env,target,None)
    def test_changed_and_deleted_rows_fail_without_values_in_error(self):
        target=self.root/'baseline';safety.snapshot(self.data,self.env,target,None)
        for sql in ("UPDATE users SET name='changed'",'DELETE FROM users'):
            with sqlite3.connect(self.data/'smooth.db') as db: db.execute(sql)
            with self.assertRaises(RuntimeError) as error: safety.compare(target/'smooth.db',self.data/'smooth.db')
            self.assertNotIn('private value',str(error.exception))
    def test_upload_symlinks_are_rejected(self):
        (self.data/'uploads/symlink').symlink_to(self.env)
        with self.assertRaises(RuntimeError): safety.snapshot(self.data,self.env,self.root/'baseline',None)
    def test_production_snapshot_requires_quiescence(self):
        with self.assertRaises(RuntimeError): safety.snapshot(Path('/var/lib/helix'),self.env,self.root/'baseline',None)
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
