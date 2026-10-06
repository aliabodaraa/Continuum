#!/usr/bin/env bash
# Back up EVERYTHING Continuum needs that git does not hold, without stopping the stack.
#
#   ./scripts/data-export.sh                           # -> _backups/continuum-backup-YYYYMMDD-HHMMSS.tgz
#   BACKUP_PASSPHRASE=... ./scripts/data-export.sh     # -> ....tgz.enc (AES-256), for copies off this machine
#
# What is in it, and why:
#   services/ca-service/ca.db          samples, profiles, decisions, study log, training queue
#   services/passkey-service/passkey.db passkey records (lose them and every user registers again)
#   apps/demo/db/*.db                  the demo app's accounts
#   services/gateway/*.json, audit.jsonl  organisations, accounts, settings, activity log, and
#                                      identity.json, which pins every user's id to their data
#   services/gateway/*.pem             the two signing keys (lose them and every organisation's
#                                      verification breaks)
#   artifacts/users/                   the per-user models
#   .env                               the deployment's secrets
#   ../paper  (as paper/)              manuscript, thesis and paper sources: no git repository holds them
# MANIFEST.json records every file's SHA-256, each database's integrity check and per-table row
# counts, and the code commit; scripts/data-import.sh --verify-only checks a backup against it.
#
# SQLite files are copied with SQLite's own backup API INSIDE the container that owns them (the
# same locking domain as the writer), so the stack keeps running and the copy is consistent. A
# database whose container is not running has no writer and is copied as it is.
# Before 2026-10-06 this script stopped the stack, and left out passkey.db, the gateway's files and
# keys, .env and the paper sources.
set -euo pipefail
cd "$(dirname "$0")/.."
TS=$(date +%Y%m%d-%H%M%S)
OUTDIR=${BACKUP_DIR:-_backups}
command -v cygpath >/dev/null && OUTDIR=$(cygpath -u "$OUTDIR")   # a Windows path (C:\...) would read as a remote host to tar
STAGE="$OUTDIR/.staging-$TS"
mkdir -p "$STAGE"
trap 'rm -rf "$STAGE"' EXIT

running() { [ -n "$(docker compose ps -q --status running "$1" 2>/dev/null)" ]; }

# sqlite_copy <compose service> <database path in the container> <same file's path in the repo>
sqlite_copy() {
  local svc=$1 inpath=$2 rel=$3 tmp
  [ -f "$rel" ] || { echo "   (none: $rel)"; return 0; }
  mkdir -p "$STAGE/$(dirname "$rel")"
  if [ -s "$rel" ] && running "$svc"; then
    tmp=".backup-$TS-$(basename "$rel")"
    MSYS_NO_PATHCONV=1 docker compose exec -T "$svc" node -e \
      "require('better-sqlite3')('$inpath',{readonly:true}).backup('$(dirname "$inpath")/$tmp').then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1)})"
    mv "$(dirname "$rel")/$tmp" "$STAGE/$rel"
    echo "   $rel (online copy inside $svc)"
  else
    cp -p "$rel" "$STAGE/$rel"
    echo "   $rel (file copy)"
  fi
}
copy() {
  local rel=$1
  [ -e "$rel" ] || { echo "   (none: $rel)"; return 0; }
  mkdir -p "$STAGE/$(dirname "$rel")"
  cp -rp "$rel" "$STAGE/$rel"
  echo "   $rel"
}

echo ">> Databases"
sqlite_copy ca-service /app/ca.db services/ca-service/ca.db
sqlite_copy passkey-service /app/passkey.db services/passkey-service/passkey.db
for f in apps/demo/db/*.db; do sqlite_copy web "/app/db/$(basename "$f")" "$f"; done
echo ">> Gateway registry, user-id map and signing keys"
for f in tenants.json accounts.json identity.json settings.json audit.jsonl principals_seed.json gwmap.json \
         gateway-identity-key.pem gateway-verdict-key.pem; do
  [ -e "services/gateway/$f" ] && copy "services/gateway/$f"
done
echo ">> Per-user models, secrets"
copy artifacts/users
copy .env
echo ">> Paper sources (../paper)"
if [ -d ../paper ]; then
  mkdir -p "$STAGE/paper"
  (cd ../paper && tar --exclude='__pycache__' --exclude='~$*' -cf - .) | (cd "$STAGE/paper" && tar -xf -)
  echo "   paper/ ($(du -sh "$STAGE/paper" | cut -f1))"
else
  echo "   (none: ../paper)"
fi

echo ">> Manifest"
python scripts/backup_manifest.py build "$STAGE"

ARCHIVE="$OUTDIR/continuum-backup-$TS.tgz"
tar --force-local -C "$STAGE" -czf "$ARCHIVE" .
if [ -n "${BACKUP_PASSPHRASE:-}" ]; then
  openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -in "$ARCHIVE" -out "$ARCHIVE.enc" -pass env:BACKUP_PASSPHRASE
  rm -f "$ARCHIVE"
  ARCHIVE="$ARCHIVE.enc"
fi
echo ">> Wrote $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1)), sha256 $(sha256sum "$ARCHIVE" | cut -c1-16)…"
echo "   Check it:  ./scripts/data-import.sh $ARCHIVE --verify-only"
echo "   It holds biometric data and secrets: keep copies off this machine only encrypted (BACKUP_PASSPHRASE)."
