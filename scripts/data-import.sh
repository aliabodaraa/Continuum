#!/usr/bin/env bash
# Restore a training-data snapshot (from data-export.sh) on a fresh checkout.
#
#   ./scripts/data-import.sh continuum-data-YYYYMMDD-HHMMSS.tgz
#
# Unpacks ca.db, continuum.db and artifacts/users/ into place for the DEV stack
# (docker-compose.yml bind-mounts them). Run BEFORE `docker compose up -d`.
set -euo pipefail
cd "$(dirname "$0")/.."

ARCHIVE="${1:?Usage: data-import.sh <continuum-data-*.tgz>}"
[ -f "$ARCHIVE" ] || { echo "ERROR: $ARCHIVE not found" >&2; exit 1; }

# Refuse to clobber a live stack silently.
if docker compose ps --status running 2>/dev/null | grep -q ca-service; then
  echo "ERROR: stack is running. Stop it first: docker compose down" >&2
  exit 1
fi

echo ">> Restoring $ARCHIVE…"
tar xzf "$ARCHIVE"

echo ">> Done. Now:"
echo "     docker compose up -d"
echo "   All keystroke/mouse training data + models are restored."
echo "   NOTE: passkeys are device-bound and were NOT migrated — each user"
echo "         re-registers a passkey on first login on this machine."
