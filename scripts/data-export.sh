#!/usr/bin/env bash
# Snapshot ALL per-user training data for migration to another machine.
#
#   ./scripts/data-export.sh
#
# Bundles: ca.db (keystroke samples/profiles/decisions), continuum.db (accounts +
# mouse samples), and artifacts/users/ (trained per-user keystroke+mouse models).
# Deliberately EXCLUDES passkey.db — passkeys are hardware-bound (Windows Hello /
# TPM) and cannot move; users re-register on the new machine.
#
# The stack is briefly stopped so the SQLite files are captured consistently.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="continuum-data-$(date +%Y%m%d-%H%M%S).tgz"

FILES=()
[ -f services/ca-service/ca.db ]   && FILES+=("services/ca-service/ca.db")
[ -f apps/demo/db/continuum.db ]   && FILES+=("apps/demo/db/continuum.db")
[ -d artifacts/users ]             && FILES+=("artifacts/users")

if [ ${#FILES[@]} -eq 0 ]; then
  echo "ERROR: no data found (ca.db / continuum.db / artifacts/users). Is this the dev checkout with enrolled users?" >&2
  exit 1
fi

echo ">> Stopping writers for a consistent snapshot…"
docker compose stop ca-service web 2>/dev/null || true

echo ">> Archiving: ${FILES[*]}"
tar czf "$OUT" "${FILES[@]}"

echo ">> Restarting…"
docker compose start ca-service web 2>/dev/null || true

echo ">> Wrote $OUT ($(du -h "$OUT" | cut -f1))"
echo "   Copy this file to PC #2 (USB / private drive — NOT GitHub), then run:"
echo "     ./scripts/data-import.sh $OUT"
