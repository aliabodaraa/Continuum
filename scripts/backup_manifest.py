"""Manifest for a Continuum backup: what is in it, and proof that a restore got it back intact.

    python scripts/backup_manifest.py build  <staging-dir>   # writes <staging-dir>/MANIFEST.json
    python scripts/backup_manifest.py verify <restored-dir>  # exit 0 only if everything checks

The manifest records, for every file, its size and SHA-256; for every SQLite database, the result
of PRAGMA integrity_check and the row count of every table; the git commit and tag of the code the
data belongs to. Verification recomputes all of it, and also parses every JSON / JSONL file and
loads every PEM private key, so a backup that cannot be used fails here, not on the day it is needed.
"""
import hashlib
import json
import os
import sqlite3
import subprocess
import sys
from datetime import datetime, timezone


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def files_under(root):
    for base, _, names in os.walk(root):
        for n in names:
            full = os.path.join(base, n)
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            if rel != "MANIFEST.json":
                yield rel, full


def sqlite_facts(path):
    if os.path.getsize(path) == 0:
        return {"integrity": "empty", "tables": {}}
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        integrity = con.execute("PRAGMA integrity_check").fetchone()[0]
        names = [r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
        tables = {n: con.execute(f'SELECT COUNT(*) FROM "{n}"').fetchone()[0] for n in names}
    finally:
        con.close()
    return {"integrity": integrity, "tables": tables}


def git(*args):
    try:
        return subprocess.check_output(["git", *args], stderr=subprocess.DEVNULL, text=True).strip()
    except Exception:
        return None


def build(root):
    files, dbs = {}, {}
    for rel, full in sorted(files_under(root)):
        files[rel] = {"bytes": os.path.getsize(full), "sha256": sha256(full)}
        if rel.endswith(".db"):
            dbs[rel] = sqlite_facts(full)
    manifest = {
        "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "code": {"commit": git("rev-parse", "HEAD"), "describe": git("describe", "--tags", "--always", "--dirty")},
        "files": files,
        "sqlite": dbs,
        "note": "Restore with scripts/data-import.sh; verify first with --verify-only.",
    }
    with open(os.path.join(root, "MANIFEST.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    total = sum(v["bytes"] for v in files.values())
    print(f"manifest: {len(files)} files, {total / 1e6:.1f} MB, {len(dbs)} databases")
    for rel, facts in dbs.items():
        rows = sum(facts["tables"].values())
        print(f"  {rel}: integrity {facts['integrity']}, {len(facts['tables'])} tables, {rows} rows")


def verify(root):
    with open(os.path.join(root, "MANIFEST.json"), encoding="utf-8") as f:
        m = json.load(f)
    problems = []
    present = {rel for rel, _ in files_under(root)}
    for rel in sorted(set(m["files"]) - present):
        problems.append(f"missing: {rel}")
    for rel in sorted(present - set(m["files"])):
        problems.append(f"not in manifest: {rel}")
    for rel, want in m["files"].items():
        full = os.path.join(root, rel)
        if rel in present and sha256(full) != want["sha256"]:
            problems.append(f"checksum differs: {rel}")
    for rel, want in m["sqlite"].items():
        full = os.path.join(root, rel)
        if rel not in present:
            continue
        got = sqlite_facts(full)
        if got["integrity"] != want["integrity"]:
            problems.append(f"{rel}: integrity {got['integrity']} (was {want['integrity']})")
        if got["tables"] != want["tables"]:
            diff = {t: (want["tables"].get(t), got["tables"].get(t)) for t in set(want["tables"]) | set(got["tables"])
                    if want["tables"].get(t) != got["tables"].get(t)}
            problems.append(f"{rel}: row counts differ {diff}")
    for rel in present:
        full = os.path.join(root, rel)
        if rel.endswith(".json"):
            try:
                with open(full, encoding="utf-8") as f:
                    json.load(f)
            except Exception as e:
                problems.append(f"{rel}: not valid JSON ({e})")
        elif rel.endswith(".jsonl"):
            with open(full, encoding="utf-8") as f:
                for i, line in enumerate(f):
                    if line.strip():
                        try:
                            json.loads(line)
                        except Exception:
                            problems.append(f"{rel}: line {i + 1} not valid JSON")
                            break
        elif rel.endswith(".pem"):
            r = subprocess.run(["openssl", "pkey", "-in", full, "-noout"], capture_output=True)
            if r.returncode != 0:
                problems.append(f"{rel}: private key does not load")
    rows = sum(sum(f["tables"].values()) for f in m["sqlite"].values())
    print(f"verified {len(m['files'])} files, {len(m['sqlite'])} databases ({rows} rows), code {m['code'].get('describe')}, "
          f"made {m['created']}")
    for p in problems:
        print("  PROBLEM:", p)
    print("BACKUP OK" if not problems else f"BACKUP FAILED ({len(problems)} problem(s))")
    return 0 if not problems else 1


if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] not in ("build", "verify"):
        sys.exit(__doc__)
    sys.exit(build(sys.argv[2]) if sys.argv[1] == "build" else verify(sys.argv[2]))
