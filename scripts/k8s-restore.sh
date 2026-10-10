#!/usr/bin/env bash
# Check, and restore, a backup made by scripts/k8s-backup.sh.
#
#   scripts/k8s-restore.sh <backup> --verify-only    restore drill, touching nothing: every file against the
#                                                    manifest; each database restored into a throwaway
#                                                    PostgreSQL (a container without network) and compared,
#                                                    table by table, with the checksums taken at backup time;
#                                                    every model against its fingerprint
#   scripts/k8s-restore.sh <backup> --restore [--yes]
#                                                    the same checks, then into this PC's cluster, replacing
#                                                    what it holds: the three databases (each in one
#                                                    transaction, then compared again), the demo's users and
#                                                    uploads, the models missing from the object store
#   scripts/k8s-restore.sh <backup> --secrets        a new PC: the backup's secrets into
#                                                    deploy/k8s/overlays/local/secrets (before k8s-local.sh deploy)
#   scripts/k8s-restore.sh <backup> --paper-to <dir> the manuscript sources (paper/) into an empty folder
#
# An encrypted backup needs BACKUP_PASSPHRASE. While the databases are replaced, the services that write
# them (gateway, ca-service, passkey-service, the demo) are stopped, and started again afterwards with as many
# copies as before: about two minutes without service.
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/lib/k8s.sh
ARCHIVE="${1:?usage: $0 <backup.tgz[.enc]> --verify-only | --restore [--yes] | --secrets | --paper-to <dir>}"
shift
MODE=""; YES=0; PAPER_TO=""
while [ $# -gt 0 ]; do
  case "$1" in
    --verify-only) MODE=verify ;;
    --restore) MODE=restore ;;
    --secrets) MODE=secrets ;;
    --paper-to) MODE=paper; PAPER_TO=${2:?--paper-to needs a folder}; shift ;;
    --yes) YES=1 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
[ -n "$MODE" ] || { echo "say what to do: --verify-only, --restore, --secrets or --paper-to <dir>" >&2; exit 2; }
[ -f "$ARCHIVE" ] || { echo "ERROR: $ARCHIVE not found" >&2; exit 1; }
command -v cygpath >/dev/null && ARCHIVE=$(cygpath -u "$ARCHIVE")

TS=$(date +%Y%m%d-%H%M%S)
WORK="_backups/.restore-k8s-$TS"
POD_TMP="/run/continuum-restore-$TS"
mkdir -p "$WORK"
cleanup() {
  oneoff_cleanup
  [ "$MODE" = restore ] && { pg_exec rm -rf "$POD_TMP" >/dev/null 2>&1 || true; k -n continuum exec deploy/model-trainer -- rm -rf "/tmp/restore-models-$TS" >/dev/null 2>&1 || true; }
  rm -rf "$WORK"
}
trap cleanup EXIT

say "unpacking $ARCHIVE"
if [[ "$ARCHIVE" == *.enc ]]; then
  : "${BACKUP_PASSPHRASE:?this backup is encrypted: set BACKUP_PASSPHRASE}"
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in "$ARCHIVE" -pass env:BACKUP_PASSPHRASE 2>/dev/null | tar -xzf - -C "$WORK" 2>/dev/null \
    || { echo "ERROR: could not decrypt $ARCHIVE: wrong BACKUP_PASSPHRASE, or the file is damaged." >&2; exit 1; }
else
  tar --force-local -xzf "$ARCHIVE" -C "$WORK"
fi
[ -f "$WORK/databases/checksums.sql" ] || { echo "ERROR: not a Kubernetes backup (no databases/): for data-export.sh backups use data-import.sh" >&2; exit 1; }

say "every file against the manifest"
python scripts/backup_manifest.py verify "$WORK" || { echo "Not restoring: the backup did not verify." >&2; exit 1; }

# ---- the smaller modes need nothing more
if [ "$MODE" = secrets ]; then
  dest=deploy/k8s/overlays/local/secrets
  if [ -d "$dest" ]; then mv "$dest" "$dest.before-restore-$TS"; echo "the secrets that were there: $dest.before-restore-$TS"; fi
  cp -rp "$WORK/secrets" "$dest" && echo "secrets restored into $dest ($(ls "$dest" | wc -l) files); next: scripts/k8s-local.sh deploy"
  exit 0
fi
if [ "$MODE" = paper ]; then
  [ ! -e "$PAPER_TO" ] || [ -z "$(ls -A "$PAPER_TO")" ] || { echo "ERROR: $PAPER_TO is not empty" >&2; exit 1; }
  mkdir -p "$PAPER_TO" && cp -rp "$WORK/paper/." "$PAPER_TO/" && echo "paper sources restored into $PAPER_TO"
  exit 0
fi

# ---- the drill: each database into a throwaway PostgreSQL, compared with its checksums
PG_IMAGE=$(sed -n 's/^ *imageName: *\([^ ]*\).*/\1/p' deploy/k8s/base/continuum/postgres.yaml | head -1)
say "restore drill: the databases into a throwaway PostgreSQL ($PG_IMAGE, no network)"
docker run --rm -i --network none -v "$(winpath "$PWD/$WORK"):/backup:ro" "$PG_IMAGE" bash -s <<'EOF'
set -euo pipefail
export PGDATA=/tmp/pgdata PGHOST=/tmp PGUSER=postgres
initdb --auth=trust --username=postgres --encoding=UTF8 --locale=C.UTF-8 >/dev/null
pg_ctl -w -l /tmp/pg.log -o "-c listen_addresses='' -k /tmp" start >/dev/null
rc=0
for dump in /backup/databases/*.dump; do
  db=$(basename "$dump" .dump)
  createdb "$db"
  pg_restore --no-owner --no-privileges --exit-on-error --dbname="$db" "$dump"
  psql -X -q -t -A -v ON_ERROR_STOP=1 -d "$db" -f /backup/databases/checksums.sql > "/tmp/$db.got"
  if cmp -s "/backup/databases/$db.checksums" "/tmp/$db.got"; then
    echo "   $db: restored; all $(grep -c '^table ' "/tmp/$db.got") tables ($(awk -F'|' '/^table /{n+=$2} END{print n+0}' "/tmp/$db.got") rows) and $(grep -c '^sequence ' "/tmp/$db.got") sequences identical to the backup"
  else
    echo "   $db: DIFFERS from the backup:"; diff "/backup/databases/$db.checksums" "/tmp/$db.got" | head -10; rc=1
  fi
done
pg_ctl -w stop >/dev/null
exit $rc
EOF

say "restore drill: every model against its fingerprint"
docker run --rm --network none -v "$(winpath "$PWD/$WORK"):/backup:ro" --entrypoint python continuum/model-api:local -c '
import json, os, sys
import model_store as ms
want = json.load(open("/backup/models/models.json"))
bad = [k for k, d in sorted(want.items()) if ms.sha256(os.path.join("/backup/models", *k.split("/"))) != d]
print(f"   models: {len(want) - len(bad)} of {len(want)} match their fingerprints")
for k in bad:
    print("   DIFFERENT:", k)
sys.exit(1 if bad else 0)'

# secrets: what differs from the ones deployed (restoring data under other secrets works, except the text-hash salt)
deployed=deploy/k8s/overlays/local/secrets
if [ -d "$deployed" ]; then
  differ=$(cd "$WORK/secrets" && for f in *; do cmp -s "$f" "$OLDPWD/$deployed/$f" || printf '%s ' "$f"; done)
  echo "secrets: ${differ:+differ from the deployed ones: $differ}${differ:-the same as the deployed ones}"
  salt_b=$(grep -E '^TEXT_HASH_SALT=' "$WORK/secrets/continuum.env" | cut -d= -f2- | tr -d '\r')
  salt_d=$(grep -E '^TEXT_HASH_SALT=' "$deployed/continuum.env" | cut -d= -f2- | tr -d '\r')
  if [ "$salt_b" != "$salt_d" ] && [ "$MODE" = restore ]; then
    echo "ERROR: TEXT_HASH_SALT differs: the restored samples would not compare with new ones. Restore the secrets first (--secrets) and deploy." >&2; exit 1
  fi
fi

if [ "$MODE" = verify ]; then say "verify-only: BACKUP RESTORABLE, nothing was changed"; exit 0; fi

# ---- the restore, into this PC's cluster
k -n continuum get cluster continuum-pg >/dev/null || { echo "no Continuum cluster in context $CTX: deploy it first (scripts/k8s-local.sh)"; exit 1; }
if [ "$YES" != 1 ]; then
  read -r -p "Replace ALL data of the cluster in context '$CTX' with this backup? [y/N] " a
  [ "$a" = y ] || { echo "nothing changed"; exit 0; }
fi

say "stopping the services that write"
declare -A COPIES
WRITERS=(continuum/gateway continuum/ca-service continuum/passkey-service)
for w in "${WRITERS[@]}"; do
  COPIES[$w]=$(k -n "${w%%/*}" get deploy "${w#*/}" -o jsonpath='{.spec.replicas}')
  k -n "${w%%/*}" scale deploy "${w#*/}" --replicas=0 >/dev/null
done
for w in "${WRITERS[@]}"; do k -n "${w%%/*}" wait --for=delete pod -l "app.kubernetes.io/name=${w#*/}" --timeout=180s >/dev/null 2>&1 || true; done
start_writers() {
  for w in "${WRITERS[@]}"; do k -n "${w%%/*}" scale deploy "${w#*/}" --replicas="${COPIES[$w]:-1}" >/dev/null; done
  for w in "${WRITERS[@]}"; do k -n "${w%%/*}" rollout status deploy "${w#*/}" --timeout=600s; done
}

say "the databases (each in one transaction: all of it or nothing)"
pg_exec mkdir -p "$POD_TMP"
cat > "$WORK/prelude.sql" <<'EOF'
\set ON_ERROR_STOP 1
SET client_min_messages = warning;
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v', 'm', 'S') ORDER BY c.relkind = 'S' LOOP
    EXECUTE format('DROP %s IF EXISTS public.%I CASCADE',
      CASE r.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'S' THEN 'SEQUENCE' ELSE 'TABLE' END, r.relname);
  END LOOP;
END $$;
EOF
pg_exec sh -c "cat > $POD_TMP/prelude.sql" < "$WORK/prelude.sql"
pg_exec sh -c "cat > $POD_TMP/checksums.sql" < "$WORK/databases/checksums.sql"
for dump in "$WORK"/databases/*.dump; do
  db=$(basename "$dump" .dump)
  owner=$(pg_exec psql -X -t -A -d postgres -c "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = '$db'")
  [ -n "$owner" ] || { echo "the cluster has no database $db"; start_writers; exit 1; }
  pg_exec sh -c "cat > $POD_TMP/$db.dump" < "$dump"
  # the old tables dropped, then the dump as the database's owner (the services' own role), in ONE transaction
  pg_exec env DB="$db" OWNER="$owner" DIR="$POD_TMP" bash -c \
    '{ cat "$DIR/prelude.sql"; printf "SET ROLE \"%s\";\n" "$OWNER"; pg_restore --no-owner --no-privileges --file=- "$DIR/$DB.dump"; } | psql -X -q -1 -v ON_ERROR_STOP=1 -d "$DB" >/dev/null' \
    || { echo "$db: the restore failed; the database is as it was"; start_writers; exit 1; }
  pg_exec psql -X -q -t -A -v ON_ERROR_STOP=1 -d "$db" -f "$POD_TMP/checksums.sql" > "$WORK/$db.after"
  if cmp -s "$WORK/databases/$db.checksums" "$WORK/$db.after"; then
    echo "   $db: restored (owner $owner); every table and sequence identical to the backup"
  else
    echo "   $db: DIFFERS after the restore:"; diff "$WORK/databases/$db.checksums" "$WORK/$db.after" | head; start_writers; exit 1
  fi
done

say "the demo's users and uploads"
demo_put "$WORK/demo/db" "$WORK/demo/uploads"

say "the models (those the object store does not hold yet)"
k -n continuum exec deploy/model-trainer -- mkdir -p "/tmp/restore-models-$TS"
(cd "$WORK/models" && tar -cf - .) | k -n continuum exec -i deploy/model-trainer -- tar -xf - -C "/tmp/restore-models-$TS"
k -n continuum exec deploy/model-trainer -- sh -c "ARTIFACTS_DIR=/tmp/restore-models-$TS python model_store.py publish-all && python model_store.py check /tmp/restore-models-$TS/models.json"
k -n continuum exec deploy/model-trainer -- rm -rf "/tmp/restore-models-$TS"

say "starting the services again"
start_writers
k -n continuum rollout restart deploy/model-inference >/dev/null && k -n continuum rollout status deploy/model-inference --timeout=600s
say "restore done: run the end-to-end suites (DEPLOY.md, Kubernetes on this PC)"
