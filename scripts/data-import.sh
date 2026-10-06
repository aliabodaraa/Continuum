#!/usr/bin/env bash
# Restore a backup made by data-export.sh, verified before anything is touched.
#
#   ./scripts/data-import.sh <backup.tgz|backup.tgz.enc> --verify-only    # restore drill: unpack, check, discard
#   ./scripts/data-import.sh <backup> --target <dir>                      # restore into another folder
#   ./scripts/data-import.sh <backup> [--no-paper]                        # restore in place (stack stopped)
#
# Every file is checked against MANIFEST.json (SHA-256), every database with integrity_check and its
# per-table row counts, every JSON / JSONL file parsed and every signing key loaded. Only a backup
# that passes is restored, and each file it replaces is first moved aside (_backups/pre-restore-<time>/
# for an in-place restore), so a restore can itself be undone. The paper sources go back to ../paper
# (or <dir>/paper with --target). An encrypted backup needs BACKUP_PASSPHRASE.
set -euo pipefail
cd "$(dirname "$0")/.."
ARCHIVE="${1:?Usage: data-import.sh <backup.tgz[.enc]> [--verify-only] [--target DIR] [--no-paper]}"
shift
VERIFY_ONLY=0; TARGET=.; PAPER=1
while [ $# -gt 0 ]; do
  case "$1" in
    --verify-only) VERIFY_ONLY=1 ;;
    --target) TARGET=${2:?--target needs a folder}; shift ;;
    --no-paper) PAPER=0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
[ -f "$ARCHIVE" ] || { echo "ERROR: $ARCHIVE not found" >&2; exit 1; }
if command -v cygpath >/dev/null; then ARCHIVE=$(cygpath -u "$ARCHIVE"); [ "$TARGET" = "." ] || TARGET=$(cygpath -u "$TARGET"); fi   # Windows paths

TS=$(date +%Y%m%d-%H%M%S)
WORK="_backups/.restore-$TS"
mkdir -p "$WORK"
trap 'rm -rf "$WORK"' EXIT
echo ">> Unpacking $ARCHIVE"
if [[ "$ARCHIVE" == *.enc ]]; then
  : "${BACKUP_PASSPHRASE:?this backup is encrypted: set BACKUP_PASSPHRASE}"
  if ! openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in "$ARCHIVE" -pass env:BACKUP_PASSPHRASE 2>/dev/null | tar -xzf - -C "$WORK" 2>/dev/null; then
    echo "ERROR: could not decrypt $ARCHIVE: wrong BACKUP_PASSPHRASE, or the file is damaged." >&2
    exit 1
  fi
else
  tar --force-local -xzf "$ARCHIVE" -C "$WORK"
fi

echo ">> Verifying against the manifest"
python scripts/backup_manifest.py verify "$WORK" || { echo "Not restoring: the backup did not verify." >&2; exit 1; }
if [ "$VERIFY_ONLY" = 1 ]; then echo ">> Verify-only: nothing was changed."; exit 0; fi

if [ "$TARGET" = "." ]; then
  if [ -n "$(docker compose ps -q --status running ca-service 2>/dev/null)" ]; then
    echo "ERROR: the stack is running. Stop it first: docker compose down" >&2
    exit 1
  fi
  ASIDE="_backups/pre-restore-$TS"; PAPER_DEST=../paper
else
  mkdir -p "$TARGET"; ASIDE="$TARGET/.pre-restore-$TS"; PAPER_DEST="$TARGET/paper"
fi

echo ">> Restoring into ${TARGET} (replaced files are kept in $ASIDE)"
n=0; kept=0
while IFS= read -r -d '' f; do
  rel=${f#"$WORK"/}
  [ "$rel" = MANIFEST.json ] && continue
  if [[ "$rel" == paper/* ]]; then
    [ "$PAPER" = 1 ] || continue
    dest="$PAPER_DEST/${rel#paper/}"
  else
    dest="$TARGET/$rel"
  fi
  if [ -e "$dest" ]; then mkdir -p "$ASIDE/$(dirname "$rel")"; mv "$dest" "$ASIDE/$rel"; kept=$((kept + 1)); fi
  mkdir -p "$(dirname "$dest")"
  cp -p "$f" "$dest"
  n=$((n + 1))
done < <(find "$WORK" -type f -print0)
# empty folders too (a saved model's assets/ is empty, and a loader may expect it)
while IFS= read -r -d '' d; do
  rel=${d#"$WORK"/}
  if [[ "$rel" == paper/* ]]; then [ "$PAPER" = 1 ] && mkdir -p "$PAPER_DEST/${rel#paper/}"; else mkdir -p "$TARGET/$rel"; fi
done < <(find "$WORK" -mindepth 1 -type d -empty -print0)
echo ">> Restored $n files ($kept replaced files moved aside)."
[ "$TARGET" = "." ] && echo "   Now: docker compose up -d   (then run the e2e tests)"
exit 0
