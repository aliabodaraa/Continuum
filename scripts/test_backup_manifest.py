"""Unit tests for scripts/backup_manifest.py: a good backup verifies, a damaged one never does.

    python -m unittest discover -s scripts -p "test_*.py"
"""
import io
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import backup_manifest as bm  # noqa: E402


def quiet(fn, *args):
    with redirect_stdout(io.StringIO()):
        return fn(*args)


class BackupManifestTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="backup-test-")
        os.makedirs(os.path.join(self.root, "services", "ca-service"))
        con = sqlite3.connect(os.path.join(self.root, "services", "ca-service", "ca.db"))
        con.execute("CREATE TABLE samples (id INTEGER PRIMARY KEY, v TEXT)")
        con.executemany("INSERT INTO samples (v) VALUES (?)", [("a",), ("b",), ("c",)])
        con.commit()
        con.close()
        with open(os.path.join(self.root, "tenants.json"), "w") as f:
            json.dump({"tenants": {"pk_x": {"name": "x"}}}, f)
        with open(os.path.join(self.root, "audit.jsonl"), "w") as f:
            f.write('{"event": "created"}\n{"event": "approved"}\n')
        os.makedirs(os.path.join(self.root, "models", "u1", "assets"))
        with open(os.path.join(self.root, "models", "u1", "model.bin"), "wb") as f:
            f.write(os.urandom(4096))
        if shutil.which("openssl"):
            subprocess.run(["openssl", "genpkey", "-algorithm", "RSA", "-out", os.path.join(self.root, "key.pem")],
                           check=True, capture_output=True)
        quiet(bm.build, self.root)

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def test_an_untouched_backup_verifies(self):
        self.assertEqual(quiet(bm.verify, self.root), 0)
        m = json.load(open(os.path.join(self.root, "MANIFEST.json")))
        self.assertEqual(m["sqlite"]["services/ca-service/ca.db"]["tables"], {"samples": 3})
        self.assertEqual(m["sqlite"]["services/ca-service/ca.db"]["integrity"], "ok")

    def test_a_changed_byte_fails(self):
        p = os.path.join(self.root, "models", "u1", "model.bin")
        data = bytearray(open(p, "rb").read())
        data[100] ^= 0xFF
        open(p, "wb").write(bytes(data))
        self.assertEqual(quiet(bm.verify, self.root), 1)

    def test_a_lost_row_fails(self):
        con = sqlite3.connect(os.path.join(self.root, "services", "ca-service", "ca.db"))
        con.execute("DELETE FROM samples WHERE id = 1")
        con.commit()
        con.close()
        self.assertEqual(quiet(bm.verify, self.root), 1)

    def test_a_missing_or_extra_file_fails(self):
        os.remove(os.path.join(self.root, "tenants.json"))
        self.assertEqual(quiet(bm.verify, self.root), 1)

    def test_an_unlisted_file_fails(self):
        open(os.path.join(self.root, "stray.txt"), "w").write("x")
        self.assertEqual(quiet(bm.verify, self.root), 1)

    @unittest.skipUnless(shutil.which("openssl"), "openssl not installed")
    def test_a_key_that_does_not_load_fails(self):
        open(os.path.join(self.root, "key.pem"), "w").write("-----BEGIN PRIVATE KEY-----\nbroken\n-----END PRIVATE KEY-----\n")
        quiet(bm.build, self.root)   # even listed in the manifest, a broken key must not pass
        self.assertEqual(quiet(bm.verify, self.root), 1)


if __name__ == "__main__":
    unittest.main()
