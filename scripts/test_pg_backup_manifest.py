"""The scheduled database copy (deploy/k8s/base/continuum/pg-backup.yaml) carries a copy of scripts/pg-checksums.sql,
because Kustomize reads no file outside its folder. The two must stay the same, and the job must be wired in."""
import os
import re
import unittest

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
BASE = os.path.join(ROOT, "deploy", "k8s", "base", "continuum")


def read(*parts):
    with open(os.path.join(*parts), encoding="utf-8") as f:
        return f.read().replace("\r\n", "\n")


def block_scalar(yaml_text, key, indent=4):
    """The lines of `<key>: |` in a ConfigMap's data, dedented by `indent`."""
    lines = yaml_text.split("\n")
    start = next(i for i, l in enumerate(lines) if l.strip() == f"{key}: |") + 1
    out = []
    for l in lines[start:]:
        if l.strip() == "":
            out.append("")
        elif l.startswith(" " * indent):
            out.append(l[indent:])
        else:
            break
    return "\n".join(out).rstrip("\n")


class PgBackupManifest(unittest.TestCase):
    def test_checksums_query_is_the_scripts_copy(self):
        manifest = read(BASE, "pg-backup.yaml")
        want = read(ROOT, "scripts", "pg-checksums.sql").rstrip("\n")
        self.assertEqual(block_scalar(manifest, "checksums.sql"), want)

    def test_scripts_are_present_and_the_job_is_wired_in(self):
        manifest = read(BASE, "pg-backup.yaml")
        self.assertIn("set -euo pipefail", block_scalar(manifest, "dump.sh"))
        self.assertIn("hashlib.sha256(back)", block_scalar(manifest, "upload.py"))
        self.assertIn("- pg-backup.yaml", read(BASE, "kustomization.yaml"))
        policies = read(BASE, "network-policies.yaml")
        self.assertRegex(policies, re.compile(r"values: \[gateway, ca-service, passkey-service, db-migrate, pg-backup\]"))
        self.assertIn("pg-backup", read(ROOT, "deploy", "k8s", "base", "storage", "seaweedfs.yaml"))


if __name__ == "__main__":
    unittest.main()
