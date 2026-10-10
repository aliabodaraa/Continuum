#!/usr/bin/env bash
# Import a Compose stack's data (the files of a checkout: the running stack's, or a copy of them) into this
# PC's Kubernetes cluster (scripts/k8s-local.sh), every part verified. The source files are only READ:
# whatever changes them (the demo's passkey re-key) happens on copies in one-off pods, so the Compose stack
# keeps its data exactly as it was, and going back to it stays a single `docker compose up`.
#
#   scripts/k8s-import.sh <checkout root>      e.g. ../continuum (the running stack: stop it first)
#
# In this order, each replacing what the cluster held:
#   1. the gateway's records (tenants, identities, accounts, settings, activity log), then the gateway restarts
#      (it takes the demo tenant's secret from this cluster's settings at start)
#   2. the demo's users (its SQLite file and uploads, onto its volume)
#   3. the demo's passkeys, re-keyed from the demo's own user numbers to Continuum ids (step 3b), then copied
#   4. ca-service's data (samples, profiles, decisions, study log, training queue)
#   5. the per-user models (into the object store)
# and finally proves the result end to end (the gateway answers with every organisation; the study log
# replays to the same verdicts and exports exactly as the source's does) and that the source files did not
# change.
set -euo pipefail
cd "$(dirname "$0")/.."
SRC=$(cd "${1:?usage: $0 <checkout root of the Compose stack whose data to import>}" && pwd)
. scripts/lib/k8s.sh
STAGE=$(mktemp -d)
trap 'oneoff_cleanup; rm -rf "$STAGE"' EXIT

# ---- the source: present, and its Compose stack not running (a consistent, quiet copy)
project=$(basename "$SRC")
if [ -n "$(docker ps -q --filter "label=com.docker.compose.project=$project")" ]; then
  echo "the Compose stack '$project' is running: stop it first (docker compose stop, in $SRC)"; exit 1
fi
GW_FILES=(tenants.json identity.json accounts.json settings.json audit.jsonl)
SOURCES=()
for f in "${GW_FILES[@]}"; do [ -f "$SRC/services/gateway/$f" ] && SOURCES+=("services/gateway/$f"); done
for f in services/passkey-service/passkey.db services/ca-service/ca.db apps/demo/db/continuum.db; do
  [ -f "$SRC/$f" ] || { echo "missing $SRC/$f"; exit 1; }
  SOURCES+=("$f")
done
say "source $SRC: ${#SOURCES[@]} files, read only"
(cd "$SRC" && sha256sum "${SOURCES[@]}") > "$STAGE/source.sha256"
mkdir -p "$STAGE/files"
(cd "$SRC" && tar -cf - "${SOURCES[@]}") | tar -xf - -C "$STAGE/files"
(cd "$STAGE/files" && sha256sum -c --quiet "$STAGE/source.sha256") && echo "staged copies identical to the source"

# a staged file into a one-off pod's /work
put() { (cd "$STAGE/files/$(dirname "$3")" && tar -cf - "$(basename "$3")") | k -n "$1" exec -i "$2" -- tar -xf - -C /work; }

# ---- 1. the gateway's records
say "1. the gateway's records"
oneoff continuum gw-import continuum/gateway:local pg-gateway gateway
for f in "${GW_FILES[@]}"; do [ -f "$STAGE/files/services/gateway/$f" ] && put continuum gw-import "services/gateway/$f"; done
k -n continuum exec gw-import -- sh -c 'node migrate.js --from /work --to "$DATABASE_URL" --replace'
k -n continuum rollout restart deploy/gateway >/dev/null && k -n continuum rollout status deploy/gateway --timeout=300s

# ---- 2. the demo's users
say "2. the demo's users"
demo_put "$STAGE/files/apps/demo/db" "$SRC/apps/demo/public/uploads"

# ---- 3. the demo's passkeys: re-keyed to Continuum ids (step 3b) on a copy, then copied
say "3. the demo's passkeys"
k -n continuum-demo exec deploy/web -- node scripts/continuum-ids.js > "$STAGE/ids.json"
echo "$(grep -o '":' "$STAGE/ids.json" | wc -l) demo users mapped to their Continuum ids"
oneoff continuum pk-import continuum/passkey-service:local pg-passkey passkey
put continuum pk-import services/passkey-service/passkey.db
k -n continuum exec -i pk-import -- sh -c 'cat > /work/ids.json' < "$STAGE/ids.json"
k -n continuum exec pk-import -- sh -c 'DB_PATH=/work/passkey.db STORAGE=sqlite node scripts/rekey-users.js /work/ids.json --apply'
k -n continuum exec pk-import -- sh -c 'node migrate.js --from /work/passkey.db --to "$DATABASE_URL" --replace'

# ---- 4. ca-service's data
say "4. ca-service's data"
oneoff continuum ca-import continuum/ca-service:local pg-ca ca
put continuum ca-import services/ca-service/ca.db
k -n continuum exec ca-import -- sh -c 'node migrate.js --from /work/ca.db --to "$DATABASE_URL" --replace'

# ---- 5. the per-user models: every model a user is served from (versions and folders from before versions)
say "5. the per-user models"
(cd "$SRC/artifacts/users" && find . -mindepth 2 -maxdepth 2 -path './user-*' \( -name final_model -o -name mouse_model -o -name mouse_action_model.joblib \
   -o -regex '.*/\(final_model\|mouse_model\|mouse_action_model\)-[0-9]\{8\}T[0-9]\{6\}Z-[0-9a-f]\{6\}' \) -print0 | tar --null -T - -cf -) \
  | k -n continuum exec -i deploy/model-trainer -- tar -xf - -C /app/artifacts/users
k -n continuum exec deploy/model-trainer -- python model_store.py publish-all

# ---- restart on the imported data; the source untouched
say "restarting on the imported data"
for d in ca-service passkey-service model-inference; do k -n continuum rollout restart "deploy/$d" >/dev/null; done
for d in ca-service passkey-service model-inference; do k -n continuum rollout status "deploy/$d" --timeout=600s; done

# ---- the proof, end to end
say "proof"
want=$(node -e 'console.log(Object.keys(require(process.argv[1]).tenants).length)' "$(winpath "$STAGE/files/services/gateway/tenants.json")")
health=$(k -n continuum exec deploy/gateway -- node -e 'fetch("http://localhost:8080/health").then(r=>r.text()).then(console.log)')
got=$(node -e 'const h=JSON.parse(process.argv[1]);console.log(h.storage==="postgres"?h.tenants:"storage "+h.storage)' "$health")
[ "$got" = "$want" ] && echo "the gateway answers from PostgreSQL with all $got organisations" || { echo "gateway: $health (expected $want organisations)"; exit 1; }
replay=$(k -n continuum exec deploy/ca-service -- sh -c 'rm -rf /tmp/proof && node scripts/study_export.js --out /tmp/proof >/dev/null 2>&1 && node scripts/study_replay.js --in /tmp/proof 2>&1 | tail -2')
echo "$replay"
grep -q "REPLAY REPRODUCES EVERY LOGGED VERDICT" <<<"$replay" || { echo "the study log does not replay to its verdicts"; exit 1; }
mkdir -p "$STAGE/proof/cluster" "$STAGE/proof/source"
k -n continuum exec deploy/ca-service -- tar -cf - -C /tmp/proof . | tar -xf - -C "$STAGE/proof/cluster"
docker run --rm --network none -v "$(winpath "$STAGE"):/s" -e STORAGE=sqlite -e DB_PATH=/s/files/services/ca-service/ca.db   continuum/ca-service:local sh -c 'node scripts/study_export.js --out /tmp/ex >/dev/null 2>&1 && cp -r /tmp/ex/. /s/proof/source/'
participants=$(cd "$STAGE/proof/source" && ls -- *.jsonl 2>/dev/null | sort || true)
[ "$participants" = "$(cd "$STAGE/proof/cluster" && ls -- *.jsonl 2>/dev/null | sort || true)" ] || { echo "the study export names other participants than the source's"; exit 1; }
nosnap() { sed -E 's/"exportedAt":"[^"]*"//' "$1" | sha256sum; }   # the export time is the one field that differs
for b in $participants; do
  [ "$(nosnap "$STAGE/proof/source/$b")" = "$(nosnap "$STAGE/proof/cluster/$b")" ] || { echo "the study export of ${b%.jsonl} differs from the source's"; exit 1; }
done
echo "the study export ($(wc -w <<<"$participants") participant(s)) is identical to the source's, apart from the export time"
(cd "$SRC" && sha256sum -c --quiet "$STAGE/source.sha256") && echo "source files unchanged: the Compose stack's data is as it was"
say "import done"
