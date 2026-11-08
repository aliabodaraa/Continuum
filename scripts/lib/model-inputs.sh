# The model image's data files that git does not hold: Dockerfile.model.prod copies them into the image, and as
# datasets they are not published with this public repository. Their SHA-256 are pinned in
# data/MODEL_IMAGE_INPUTS.sha256, so a build, a backup and a restore can tell the right files from missing or changed
# ones. Before 2026-11-08 nothing recorded them: a lost disk or a `docker system prune` left no way to rebuild the
# model image, and typing and mouse enrolment with it. Sourced by k8s-local.sh, k8s-backup.sh, k8s-restore.sh and
# release.sh, which run from the repository's root.
MODEL_INPUTS_LIST=data/MODEL_IMAGE_INPUTS.sha256

# model_inputs_files: the listed paths, one per line.
model_inputs_files() { tr -d '\r' < "$MODEL_INPUTS_LIST" | awk 'NF == 2 { print $2 }'; }

# model_inputs_check [ROOT]: every listed file is under ROOT (default .) with its pinned SHA-256. Says which are not.
model_inputs_check() {
  local root=${1:-.} sum f bad=0
  while read -r sum f; do
    [ -n "$f" ] || continue
    if [ ! -f "$root/$f" ]; then echo "missing: $f" >&2; bad=1
    elif [ "$(sha256sum "$root/$f" | cut -d' ' -f1)" != "$sum" ]; then echo "not the pinned file (SHA-256 differs): $f" >&2; bad=1
    fi
  done < <(tr -d '\r' < "$MODEL_INPUTS_LIST")
  return $bad
}

# model_inputs_copy FROM TO: the listed files present under FROM, copied to the same paths under TO.
model_inputs_copy() {
  local f
  while read -r f; do
    [ -f "$1/$f" ] || continue
    mkdir -p "$2/$(dirname "$f")" && cp -p "$1/$f" "$2/$f"
  done < <(model_inputs_files)
}
