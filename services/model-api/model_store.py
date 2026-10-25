"""Where per-user models live, and how every copy of this service finds the same ones.

Versions. Every training writes a NEW folder beside the user's others,
    users/user-<id>/<leaf>-<YYYYMMDDTHHMMSSZ>-<6 hex>      (leaf: final_model, mouse_model, mouse_action_model)
and never changes it again. The caller (ca-service) keeps which version is current and passes it with
every scoring request, so a retrain never changes what another copy is serving, a rejected retrain is
simply never adopted (and discarded), and a copy's in-memory model cache needs no invalidation. Folders
made before versions existed (users/user-<id>/final_model, ...) keep working as they are.

Storage, MODEL_STORE:
    fs  (default) ARTIFACTS_DIR is the storage: one host, or one volume every copy mounts.
    s3  any S3 API (SeaweedFS locally; S3, GCS, R2 in a cloud). After a training the trainer uploads the
        version, then a marker object holding its file list and hash. A copy asked for a version it does
        not have downloads it into its local ARTIFACTS_DIR (only a cache then), checks the hash, and only
        then moves it into place, so a half-downloaded model is never loaded.

The fingerprint (sha256) is the one ca-service's study log has always recorded for a model folder:
over the folder's files in path order, each file's path relative to the folder, a NUL byte, then its
bytes. The trainer returns it, so ca-service no longer needs to read model files itself.

Imports nothing heavy at module level (the unit tests run without NumPy, TensorFlow or boto3).
"""
import hashlib
import json
import os
import re
import secrets
import shutil
import threading
import time

ARTIFACTS_DIR = os.getenv("ARTIFACTS_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "artifacts"))
KIND = os.getenv("MODEL_STORE", "fs").lower()
BUCKET = os.getenv("MODEL_S3_BUCKET", "models")
KEEP_LATEST = int(os.getenv("MODEL_KEEP_VERSIONS", "3"))   # newest versions kept per user and kind

VERSION_RE = re.compile(r"-(\d{8}T\d{6}Z)-([0-9a-f]{6})$")
# A model a user is served from: a version, or a folder (file) made before versions.
LIVE_NAME = re.compile(r"^(final_model|mouse_model|mouse_action_model)(-\d{8}T\d{6}Z-[0-9a-f]{6}|\.joblib)?$")
_locks = {}
_locks_guard = threading.Lock()
_client = None


# ---------------------------------------------------------------- versions
def new_version(base):
    """A new, unused version path for the model family `base` (e.g. .../user-7/final_model)."""
    return f"{base}-{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}-{secrets.token_hex(3)}"


def is_version(path):
    return bool(VERSION_RE.search(str(path).rstrip("/\\")))


def unit(path):
    """What is stored, fetched and deleted as one: the version folder, also for a model that is one
    file inside it (the mouse action model); any other path as it is."""
    parent = os.path.dirname(str(path).rstrip("/\\"))
    return parent if is_version(parent) else path


def family(path):
    """The family a version belongs to (its path without the version suffix)."""
    return VERSION_RE.sub("", str(path).rstrip("/\\"))


# ---------------------------------------------------------------- fingerprint
def _files(path):
    if os.path.isfile(path):
        return [path]
    out = []
    for base, _, names in os.walk(path):
        out.extend(os.path.join(base, n) for n in names if os.path.isfile(os.path.join(base, n)))
    return sorted(out)


def sha256(path):
    """The model's fingerprint (see the module note); None if it does not exist."""
    if not path or not os.path.exists(path):
        return None
    h = hashlib.sha256()
    for f in _files(path):
        rel = "" if f == path else os.path.relpath(f, path).replace(os.sep, "/")
        h.update(rel.encode() + b"\0")
        with open(f, "rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                h.update(chunk)
    return h.hexdigest()


# ---------------------------------------------------------------- S3
def _s3():
    global _client
    if _client is None:
        import boto3
        from botocore.config import Config
        _client = boto3.client(
            "s3",
            endpoint_url=os.getenv("MODEL_S3_ENDPOINT") or None,
            aws_access_key_id=os.getenv("MODEL_S3_ACCESS_KEY") or None,
            aws_secret_access_key=os.getenv("MODEL_S3_SECRET_KEY") or None,
            region_name=os.getenv("MODEL_S3_REGION", "us-east-1"),
            config=Config(s3={"addressing_style": "path"}, retries={"max_attempts": 5, "mode": "standard"},
                          connect_timeout=5, read_timeout=60),
        )
    return _client


def _key(path):
    """The object key of a model under ARTIFACTS_DIR (only per-user models are stored)."""
    rel = os.path.relpath(os.path.realpath(path), os.path.realpath(ARTIFACTS_DIR)).replace(os.sep, "/")
    if not rel.startswith("users/") or ".." in rel.split("/"):
        raise ValueError(f"not a per-user model path: {path}")
    return rel


def ensure_bucket(wait_s=None):
    """At start: the bucket exists. The object store may still be starting (a rollout, a restart of the whole
    machine), so an endpoint that does not answer is retried for a bounded time (BOOT_WAIT_MS, default two
    minutes) instead of failing the pod at once, which the orchestrator would retry with a growing back-off."""
    if KIND != "s3":
        return
    if wait_s is None:
        wait_s = float(os.getenv("BOOT_WAIT_MS", "120000")) / 1000
    c = _s3()
    deadline = time.monotonic() + wait_s
    attempt = 0
    while True:
        attempt += 1
        try:
            try:
                c.head_bucket(Bucket=BUCKET)
            except c.exceptions.ClientError as e:
                if e.response.get("Error", {}).get("Code") not in ("404", "NoSuchBucket"):
                    raise
                c.create_bucket(Bucket=BUCKET)
            return
        except Exception as e:  # the endpoint is down, or its name does not resolve yet
            left = deadline - time.monotonic()
            if left <= 0:
                raise
            if attempt == 1 or attempt % 5 == 0:
                print(f"[model-store] object store not ready ({type(e).__name__}: {e}); retrying for another {int(left)} s")
            time.sleep(min(2.0, left))


def _lock(path):
    with _locks_guard:
        return _locks.setdefault(path, threading.Lock())


def publish(path, digest=None):
    """After a training: make the version available to every copy. Files first, the marker last, so a
    reader that finds the marker finds the whole model. Returns its fingerprint."""
    digest = digest or sha256(path)
    if KIND != "s3" or not path or not os.path.exists(path):
        return digest
    key, c = _key(path), _s3()
    files = []
    for f in _files(path):
        rel = "" if f == path else os.path.relpath(f, path).replace(os.sep, "/")
        c.upload_file(f, BUCKET, key if rel == "" else f"{key}/{rel}")
        files.append(rel)
    marker = {"sha256": digest, "kind": "file" if os.path.isfile(path) else "dir", "files": files,
              "publishedAtUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    c.put_object(Bucket=BUCKET, Key=f"{key}.complete", Body=json.dumps(marker).encode(),
                 ContentType="application/json")
    return digest


def ensure_local(path):
    """Before loading: make sure this copy has the model. True if it is (now) here."""
    if not path:
        return False
    if os.path.exists(path):
        return True
    if KIND != "s3":
        return False
    try:
        key = _key(path)
    except ValueError:
        return False
    with _lock(path):
        if os.path.exists(path):
            return True
        c = _s3()
        try:
            marker = json.loads(c.get_object(Bucket=BUCKET, Key=f"{key}.complete")["Body"].read())
        except Exception as exc:
            code = str(getattr(exc, "response", {}).get("Error", {}).get("Code", ""))
            if code in ("NoSuchKey", "404", "NotFound"):
                return False                          # never published: the caller answers "not found"
            raise
        _fetch(c, key, marker, path)
        print(f"[store] fetched {key} ({len(marker['files'])} files)")
        return True


def _fetch(c, key, marker, path):
    """Download the stored model `key` to `path`: into a temporary name, checked against its marker's
    fingerprint, and only then moved into place."""
    tmp = f"{path}.part-{secrets.token_hex(4)}"
    try:
        for rel in marker["files"]:
            dst = tmp if rel == "" else os.path.join(tmp, *rel.split("/"))
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            c.download_file(BUCKET, key if rel == "" else f"{key}/{rel}", dst)
        if marker["kind"] == "dir":
            os.makedirs(tmp, exist_ok=True)
        got = sha256(tmp)
        if got != marker["sha256"]:
            raise RuntimeError(f"downloaded model {key} does not match its fingerprint")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            shutil.rmtree(tmp, ignore_errors=True) if os.path.isdir(tmp) else os.remove(tmp)


def _remove_local(path):
    if os.path.isdir(path):
        shutil.rmtree(path, ignore_errors=True)
    elif os.path.exists(path):
        os.remove(path)


def delete(path):
    """Remove one version everywhere (a rejected retrain, or an old version)."""
    if not is_version(path):
        raise ValueError(f"only versions are deleted, never a model made before versions: {path}")
    _remove_local(path)
    if KIND == "s3":
        key, c = _key(path), _s3()
        c.delete_object(Bucket=BUCKET, Key=f"{key}.complete")   # unpublish first
        for page in c.get_paginator("list_objects_v2").paginate(Bucket=BUCKET, Prefix=f"{key}/"):
            for o in page.get("Contents", []):
                c.delete_object(Bucket=BUCKET, Key=o["Key"])
        c.delete_object(Bucket=BUCKET, Key=key)


def versions(base):
    """Every version of the family `base`, local or stored, oldest first."""
    found = set()
    parent, leaf = os.path.dirname(base), os.path.basename(base)
    if os.path.isdir(parent):
        found.update(os.path.join(parent, n) for n in os.listdir(parent)
                     if n.startswith(leaf + "-") and is_version(n))
    if KIND == "s3":
        prefix, c = _key(base) + "-", _s3()
        for page in c.get_paginator("list_objects_v2").paginate(Bucket=BUCKET, Prefix=prefix):
            for o in page.get("Contents", []):
                if o["Key"].endswith(".complete"):
                    found.add(os.path.join(ARTIFACTS_DIR, *o["Key"][: -len(".complete")].split("/")))
    found = {p for p in found if family(p) == base.rstrip("/\\")}
    return sorted(found, key=lambda p: VERSION_RE.search(p).group(0))


def prune(base, keep=()):
    """Delete old versions of a family: kept are the KEEP_LATEST newest and every path in `keep` (the
    caller's current version). Returns the deleted paths."""
    vs = versions(base)
    keep = {os.path.realpath(k) for k in keep if k}
    old = [p for p in vs[:-KEEP_LATEST] if os.path.realpath(p) not in keep] if KEEP_LATEST > 0 else []
    for p in old:
        try:
            delete(p)
        except Exception as exc:                      # pruning is housekeeping: never fail a training
            print(f"[store] could not delete {p}: {exc}")
    return old


# ---------------------------------------------------------------- the feed of new versions
# A scoring copy loads a model on its first request for it, and a TensorFlow model takes longer to load
# than ca-service's 5 s scoring deadline: the user's first check after every retrain would get no verdict
# on every copy. So the trainer announces each version it publishes, and every scoring copy follows the
# announcements and loads new versions in the background, well before the user's next check. One small
# entry per version (no list rewritten, so two trainers never overwrite each other's), named by time so
# a copy reads only what is new; entries older than FEED_KEEP_S are removed by the trainer.
FEED_KEEP_S = float(os.getenv("MODEL_FEED_KEEP_S", str(2 * 86400)))
_FEED_DIR = os.path.join(ARTIFACTS_DIR, "users", ".feed")


def announce(path):
    """Tell the scoring copies that this version exists (after publish)."""
    entry = f"{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}-{secrets.token_hex(4)}"
    rel = os.path.relpath(os.path.realpath(path), os.path.realpath(ARTIFACTS_DIR)).replace(os.sep, "/")
    cutoff = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime(time.time() - FEED_KEEP_S))
    if KIND == "s3":
        c = _s3()
        c.put_object(Bucket=BUCKET, Key=f"feed/{entry}", Body=rel.encode())
        for page in c.get_paginator("list_objects_v2").paginate(Bucket=BUCKET, Prefix="feed/"):
            for o in page.get("Contents", []):
                if o["Key"][len("feed/"):] < cutoff:
                    c.delete_object(Bucket=BUCKET, Key=o["Key"])
    else:
        os.makedirs(_FEED_DIR, exist_ok=True)
        with open(os.path.join(_FEED_DIR, entry + ".tmp"), "w", encoding="utf-8") as f:
            f.write(rel)
        os.replace(os.path.join(_FEED_DIR, entry + ".tmp"), os.path.join(_FEED_DIR, entry))
        for name in os.listdir(_FEED_DIR):
            if not name.endswith(".tmp") and name < cutoff:
                os.remove(os.path.join(_FEED_DIR, name))


def feed_after(cursor, since_s=None):
    """[(entry, model path)] announced after `cursor` (an entry name; "" = from `since_s` seconds ago)."""
    floor = cursor or time.strftime("%Y%m%dT%H%M%SZ", time.gmtime(time.time() - (since_s or 0)))
    out = []
    if KIND == "s3":
        c = _s3()
        for page in c.get_paginator("list_objects_v2").paginate(Bucket=BUCKET, Prefix="feed/", StartAfter=f"feed/{floor}"):
            for o in page.get("Contents", []):
                rel = c.get_object(Bucket=BUCKET, Key=o["Key"])["Body"].read().decode()
                out.append((o["Key"][len("feed/"):], rel))
    elif os.path.isdir(_FEED_DIR):
        for name in sorted(os.listdir(_FEED_DIR)):
            if name > floor and not name.endswith(".tmp"):
                with open(os.path.join(_FEED_DIR, name), encoding="utf-8") as f:
                    out.append((name, f.read().strip()))
    return [(e, os.path.join(ARTIFACTS_DIR, *rel.split("/"))) for e, rel in sorted(out) if rel.startswith("users/")]


def publish_all():
    """Upload every per-user model under ARTIFACTS_DIR/users that is not stored, or is stored with other
    content (moving to s3, an import, a restore). A version never changes, but a folder made before versions
    (users/user-<id>/final_model) was rewritten in place by every training, so the same name can hold other
    content than the stored copy: the fingerprint decides, not the name. Returns (uploaded, already stored,
    of the uploaded: replacing other content)."""
    root = os.path.join(ARTIFACTS_DIR, "users")
    c, done, skipped, replaced = _s3(), 0, 0, 0
    ensure_bucket()
    for user in sorted(os.listdir(root)) if os.path.isdir(root) else []:
        udir = os.path.join(root, user)
        if not user.startswith("user-") or not os.path.isdir(udir):   # research runs live here too
            continue
        for name in sorted(os.listdir(udir)):
            p = os.path.join(udir, name)
            if not LIVE_NAME.match(name):            # snapshots, scratch folds, backups: not served
                continue
            digest = sha256(p)
            try:
                stored = json.loads(c.get_object(Bucket=BUCKET, Key=f"{_key(p)}.complete")["Body"].read())
            except Exception:
                stored = None
            if stored and stored.get("sha256") == digest:
                skipped += 1
                continue
            if stored:
                replaced += 1
                print(f"[store] {_key(p)}: stored with other content, replaced")
            publish(p, digest)
            done += 1
    return done, skipped, replaced


def _stored():
    """{key: marker} of every per-user model in the object store."""
    c, out = _s3(), {}
    for page in c.get_paginator("list_objects_v2").paginate(Bucket=BUCKET, Prefix="users/"):
        for o in page.get("Contents", []):
            if o["Key"].endswith(".complete"):
                out[o["Key"][: -len(".complete")]] = json.loads(c.get_object(Bucket=BUCKET, Key=o["Key"])["Body"].read())
    return out


def export_all(dest):
    """A backup of the object store: every stored per-user model downloaded to dest/<key>, each checked
    against its fingerprint, and dest/models.json ({key: fingerprint}). Returns the number of models."""
    c, prints = _s3(), {}
    for key, marker in sorted(_stored().items()):
        _fetch(c, key, marker, os.path.join(dest, *key.split("/")))
        prints[key] = marker["sha256"]
    with open(os.path.join(dest, "models.json"), "w", encoding="utf-8") as f:
        json.dump(prints, f, indent=1, sort_keys=True)
    return len(prints)


def check_stored(expected):
    """After a restore: the keys of `expected` ({key: fingerprint}) that are NOT stored with that fingerprint."""
    stored = _stored()
    return sorted(k for k, digest in expected.items() if (stored.get(k) or {}).get("sha256") != digest)


USAGE = """usage: python model_store.py publish-all          upload every model under ARTIFACTS_DIR/users not stored as it is
       python model_store.py export-all <dir>     download every stored model into <dir> (a backup), checked
       python model_store.py check <models.json>  is every model of a backup stored, with its fingerprint?"""

if __name__ == "__main__":
    import sys
    args = sys.argv[1:]
    if args[:1] and KIND != "s3":
        sys.exit("MODEL_STORE is not s3: the object store commands do not apply")
    if args == ["publish-all"]:
        n, s, r = publish_all()
        print(f"uploaded {n} model(s) ({r} replacing other content), {s} already stored as they are")
    elif len(args) == 2 and args[0] == "export-all":
        print(f"exported {export_all(args[1])} model(s), each matching its fingerprint")
    elif len(args) == 2 and args[0] == "check":
        with open(args[1], encoding="utf-8") as f:
            expected = json.load(f)
        missing = check_stored(expected)
        print(f"{len(expected) - len(missing)} of {len(expected)} model(s) stored with their fingerprint")
        for k in missing:
            print(f"  missing or different: {k}")
        sys.exit(1 if missing else 0)
    else:
        sys.exit(USAGE)
