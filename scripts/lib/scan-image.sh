#!/usr/bin/env bash
# scan_image IMAGE...: fail when an image carries secrets, databases, backups or identity snapshots.
# Used by scripts/k8s-local.sh build and scripts/release.sh before anything is deployed or pushed; CI runs the same
# pattern (.github/workflows/ci.yml). Added 2026-11-08: five ca.db.pre-*.bak copies holding participants'
# keystrokes had reached the ca-service image because its .dockerignore excluded only *.db.
#   bash scripts/lib/scan-image.sh continuum/ca-service:local [more images...]
scan_image() {
  local img leaked rc=0
  for img in "$@"; do
    leaked=$(MSYS_NO_PATHCONV=1 docker run --rm --entrypoint sh "$img" -c \
      'find / -xdev \( -name "*.pem" -o -name "*.db" -o -name "*.db-*" -o -name "*.bak" -o -name "*.sqlite*" \
         -o -name "*snapshot*.json" -o -name reconstructed.json -o -name ".env" -o -name tenants.json \
         -o -name accounts.json -o -name identity.json -o -name audit.jsonl \) \
         -not -path "*/node_modules/*" -not -path "/usr/*" -not -path "/etc/*" -not -path "/proc/*" -not -path "/sys/*" 2>/dev/null' \
      || true)
    if [ -n "$leaked" ]; then
      echo "ERROR: $img carries secret, database or backup files:" >&2
      echo "$leaked" >&2
      rc=1
    else
      echo "clean: $img"
    fi
  done
  return $rc
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  [ $# -gt 0 ] || { echo "usage: $0 IMAGE..." >&2; exit 2; }
  scan_image "$@"
fi
