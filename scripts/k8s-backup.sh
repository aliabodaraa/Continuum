#!/usr/bin/env bash
# Back up everything the Kubernetes system holds (scripts/k8s-local.sh), and what git does not, without
# stopping anything. The counterpart of scripts/data-export.sh for the cluster.
#
#   scripts/k8s-backup.sh                          -> _backups/continuum-k8s-backup-YYYYMMDD-HHMMSS.tgz
#   BACKUP_PASSPHRASE=... scripts/k8s-backup.sh    -> ....tgz.enc (AES-256), for copies off this machine
#
# What is in it, and why:
#   databases/<db>.dump       gateway, ca, passkey: each PostgreSQL database (pg_dump, custom format):
#                             organisations, accounts, user ids, activity log; samples, profiles, decisions,
#                             study log, training queue; passkeys
#   databases/<db>.checksums  each table's row count and content hash, each sequence's value, taken IN THE
#                             DUMP'S OWN SNAPSHOT (scripts/pg-checksums.sql, kept as databases/checksums.sql):
#                             a restore is proven by printing the same lines
#   demo/db/continuum.db      the demo's users (SQLite's online backup, inside the demo's pod)
#   demo/uploads/             the demo's uploaded files
#   models/users/...          every per-user model in the object store, each checked against its fingerprint
#                             on the way out; models/models.json lists them with their fingerprints
#   secrets/                  deploy/k8s/overlays/local/secrets: every secret and both signing keys (lose them
#                             and every organisation's verification breaks)
#   .env, paper/              as data-export.sh: the operator key's source, and ../paper (no git repository
#                             holds the manuscript sources)
# MANIFEST.json (scripts/backup_manifest.py) records every file's SHA-256, the SQLite file's integrity and
# row counts, and the code commit. Check a backup, touching nothing:
#   scripts/k8s-restore.sh <backup> --verify-only
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/lib/k8s.sh
TS=$(date +%Y%m%d-%H%M%S)
OUTDIR=${BACKUP_DIR:-_backups}
command -v cygpath >/dev/null && OUTDIR=$(cygpath -u "$OUTDIR")   # a Windows path (C:\...) would read as a remote host to tar
STAGE="$OUTDIR/.staging-k8s-$TS"
POD_TMP="/run/continuum-backup-$TS"                                # in the PostgreSQL pod (a writable volume)
mkdir -p "$STAGE"
cleanup() {
  oneoff_cleanup
  pg_exec rm -rf "$POD_TMP" >/dev/null 2>&1 || true
  k -n continuum exec deploy/model-trainer -- rm -rf "/tmp/backup-models-$TS" >/dev/null 2>&1 || true
  k -n continuum-demo exec deploy/web -- rm -f "/app/data/.backup-$TS.db" >/dev/null 2>&1 || true
  rm -rf "$STAGE"
}
trap cleanup EXIT

k -n continuum get cluster continuum-pg >/dev/null || { echo "no Continuum cluster in context $CTX"; exit 1; }

say "databases (one consistent snapshot each)"
mkdir -p "$STAGE/databases"
cp scripts/pg-checksums.sql "$STAGE/databases/checksums.sql"
pg_exec mkdir -p "$POD_TMP"
for db in gateway ca passkey; do
  # One read-only transaction: its snapshot is exported to pg_dump (\setenv + \!), and the checksums are
  # taken in it too, so they describe exactly what the dump holds, whatever is written meanwhile.
  { printf '%s\n' '\set ON_ERROR_STOP 1' 'BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY;' \
      'SELECT pg_export_snapshot() AS snap \gset' '\setenv SNAP :snap' \
      '\! pg_dump --format=custom --no-owner --no-privileges --snapshot="$SNAP" --dbname="$DB" --file="$OUT" 2>"$OUT.err"; echo $? > "$OUT.rc"'
    cat scripts/pg-checksums.sql
    echo 'COMMIT;'
  } | pg_exec env DB="$db" OUT="$POD_TMP/$db.dump" psql -X -q -t -A -d "$db" > "$STAGE/databases/$db.checksums"
  rc=$(pg_exec cat "$POD_TMP/$db.dump.rc")
  [ "$rc" = 0 ] || { echo "pg_dump $db failed:"; pg_exec cat "$POD_TMP/$db.dump.err"; exit 1; }
  pg_exec cat "$POD_TMP/$db.dump" > "$STAGE/databases/$db.dump"
  want=$(pg_exec sha256sum "$POD_TMP/$db.dump" | cut -d' ' -f1)
  got=$(sha256sum "$STAGE/databases/$db.dump" | cut -d' ' -f1)
  [ "$want" = "$got" ] || { echo "$db: the copied dump differs from the one in the pod"; exit 1; }
  echo "   $db: $(grep -c '^table ' "$STAGE/databases/$db.checksums") tables, $(awk -F'|' '/^table /{n+=$2} END{print n+0}' "$STAGE/databases/$db.checksums") rows, dump $(du -h "$STAGE/databases/$db.dump" | cut -f1)"
done

say "the demo's users and uploads"
mkdir -p "$STAGE/demo/db" "$STAGE/demo/uploads"
k -n continuum-demo exec deploy/web -- node -e \
  "require('better-sqlite3')('/app/data/continuum.db',{readonly:true}).backup('/app/data/.backup-$TS.db').then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1)})"
k -n continuum-demo exec deploy/web -- cat "/app/data/.backup-$TS.db" > "$STAGE/demo/db/continuum.db"
k -n continuum-demo exec deploy/web -- rm -f "/app/data/.backup-$TS.db"
k -n continuum-demo exec deploy/web -- tar -cf - -C /app/public/uploads . | tar -xf - -C "$STAGE/demo/uploads"
echo "   demo/db/continuum.db (online copy), demo/uploads ($(find "$STAGE/demo/uploads" -type f | wc -l) files)"

say "the per-user models (from the object store)"
k -n continuum exec deploy/model-trainer -- python model_store.py export-all "/tmp/backup-models-$TS"
mkdir -p "$STAGE/models"
k -n continuum exec deploy/model-trainer -- tar -cf - -C "/tmp/backup-models-$TS" . | tar -xf - -C "$STAGE/models"
k -n continuum exec deploy/model-trainer -- rm -rf "/tmp/backup-models-$TS"

say "secrets, .env, paper sources"
cp -rp deploy/k8s/overlays/local/secrets "$STAGE/secrets" && echo "   secrets/ ($(ls "$STAGE/secrets" | wc -l) files)"
[ -f .env ] && cp -p .env "$STAGE/.env" && echo "   .env"
if [ -d ../paper ]; then
  mkdir -p "$STAGE/paper"
  (cd ../paper && tar --exclude='__pycache__' --exclude='~$*' -cf - .) | (cd "$STAGE/paper" && tar -xf -)
  echo "   paper/ ($(du -sh "$STAGE/paper" | cut -f1))"
else
  echo "   (none: ../paper)"
fi

say "manifest"
python scripts/backup_manifest.py build "$STAGE" "Kubernetes backup: check with scripts/k8s-restore.sh <backup> --verify-only, restore with --restore."

ARCHIVE="$OUTDIR/continuum-k8s-backup-$TS.tgz"
tar --force-local -C "$STAGE" -czf "$ARCHIVE" .
if [ -n "${BACKUP_PASSPHRASE:-}" ]; then
  openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -in "$ARCHIVE" -out "$ARCHIVE.enc" -pass env:BACKUP_PASSPHRASE
  rm -f "$ARCHIVE"
  ARCHIVE="$ARCHIVE.enc"
fi
say "wrote $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1)), sha256 $(sha256sum "$ARCHIVE" | cut -c1-16)…"
echo "   check it:  scripts/k8s-restore.sh $ARCHIVE --verify-only"
echo "   It holds biometric data and secrets: keep copies off this machine only encrypted (BACKUP_PASSPHRASE)."
