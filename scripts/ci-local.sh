#!/usr/bin/env bash
# Runs the checks of .github/workflows/ci.yml on this machine, all in Docker (nothing is installed on
# the host). Run it before every push: GitHub Actions does not run for this repository at the moment.
#
#   ./scripts/ci-local.sh            syntax, compose files, unit tests, Dockerfile and workflow lint (~1 min)
#   ./scripts/ci-local.sh --images   also builds every image and checks that none carries a key, a
#                                    database, .env or account files (slow the first time: model-api)
#   ./scripts/ci-local.sh --scan     --images plus a vulnerability scan of each image (Trivy; report
#                                    only, like CI; downloads its database the first time)
#
# Exit code 0 means every check passed. The tests run on a clean copy of the files git would commit
# (tracked and new files, not ignored ones), like CI's checkout; the image builds use the working
# tree, so they also prove .dockerignore keeps local secrets out.
set -uo pipefail
cd "$(dirname "$0")/.."

IMAGES=0; SCAN=0
for a in "$@"; do
  case "$a" in
    --images) IMAGES=1 ;;
    --scan) IMAGES=1; SCAN=1 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "unknown option: $a (see --help)" >&2; exit 2 ;;
  esac
done

NODE_IMAGE="${CI_NODE_IMAGE:-node:24-bookworm-slim}"        # the services' own base image
PY_IMAGE="${CI_PY_IMAGE:-python:3.11.9-slim-bookworm}"
# Windows (Git Bash): docker wants Windows paths and no MSYS path rewriting.
if command -v cygpath >/dev/null 2>&1; then
  export MSYS_NO_PATHCONV=1
  winpath() { cygpath -w "$1"; }
else
  winpath() { echo "$1"; }
fi
ROOT_D="$(winpath "$(pwd)")"
EMPTY_ENV="$(mktemp)"

# A throwaway PostgreSQL on its own network, for the storage tests that need a real database
# (TEST_DATABASE_URL). Removed at the end; it never sees a real deployment's data.
PG_IMAGE="${CI_PG_IMAGE:-postgres:16-alpine}"
NET="continuum-ci-$$"
PG_URL=""
start_pg() {
  docker network create "$NET" >/dev/null 2>&1 || return 1
  docker run -d --rm --name "$NET-pg" --network "$NET" -e POSTGRES_PASSWORD=ci -e POSTGRES_DB=ci "$PG_IMAGE" >/dev/null || return 1
  local i
  for i in $(seq 1 60); do   # over TCP: the server that only runs during initialisation does not listen there
    if docker exec "$NET-pg" pg_isready -h 127.0.0.1 -U postgres -d ci -q 2>/dev/null; then
      PG_URL="postgres://postgres:ci@$NET-pg:5432/ci"; return 0
    fi
    sleep 1
  done
  return 1
}
stop_pg() { docker rm -f "$NET-pg" >/dev/null 2>&1; docker network rm "$NET" >/dev/null 2>&1; }
trap 'rm -f "$EMPTY_ENV"; stop_pg' EXIT

passed=(); failed=()
step() {
  local name="$1"; shift
  echo; echo "== $name"
  if "$@"; then passed+=("$name"); else failed+=("$name"); fi
}

# The files git would commit, minus model weights, datasets and images: what CI checks out.
sources() {
  git ls-files -co --exclude-standard -z -- services apps sdk extension packages scripts tools examples \
    | grep -zvE '\.(h5|keras|bin|png|jpg|jpeg|gif|ico|zip|npz|npy|pkl|db)$' \
    | tar --null -T - -cf -
}

node_checks() {
  local net=()
  if start_pg; then
    net=(--network "$NET" -e "TEST_DATABASE_URL=$PG_URL")
    echo "throwaway PostgreSQL ready ($PG_IMAGE)"
  else
    echo "WARNING: PostgreSQL did not start; the postgres storage tests are skipped"
  fi
  sources | docker run --rm -i ${net[@]+"${net[@]}"} -e npm_config_update_notifier=false "$NODE_IMAGE" bash -c '
    mkdir -p /w && cd /w && tar -xf - || exit 1
    fail=0
    while IFS= read -r -d "" f; do node --check "$f" || { echo "syntax error: $f"; fail=1; }; done \
      < <(find services apps sdk extension packages scripts tools examples -type f \( -name "*.js" -o -name "*.mjs" \) \
            -not -path "*/node_modules/*" -not -path "*/vendor/*" -print0 2>/dev/null)
    [ "$fail" = 0 ] || exit 1
    echo "JavaScript syntax: ok"
    for f in scripts/*.sh; do bash -n "$f" || exit 1; done
    echo "shell syntax: ok"
    for d in services/ca-service services/gateway services/passkey-service; do
      (cd "$d" && npm ci --omit=dev --no-audit --no-fund --loglevel=error >/dev/null) \
        || { echo "npm ci failed in $d (is package-lock.json in step with package.json?)"; exit 1; }
    done
    node --test --test-reporter=spec services/gateway/test/*.test.js services/ca-service/test/*.test.js services/passkey-service/test/*.test.js
  '
}

python_checks() {
  sources | docker run --rm -i "$PY_IMAGE" bash -c '
    mkdir -p /w && cd /w && tar -xf - || exit 1
    python -m compileall -q services/model-api scripts tools || exit 1
    echo "Python syntax: ok"
    python -m unittest discover -s scripts -p "test_*.py" || exit 1
    python -m unittest discover -s services/model-api/tests
  '
}

compose_checks() {
  # An empty env file and dummy secrets, as in CI: a file that only works with this PC's .env fails here.
  local f rc=0
  for f in docker-compose.yml docker-compose.prod.yml docker-compose.bundle.yml; do
    if MODEL_API_KEY=ci CA_SIGNING_SECRET=ci SESSION_SECRET=ci GATEWAY_SESSION_SECRET=ci GATEWAY_ADMIN_KEY=ci REGISTRY=ci \
       docker compose --env-file "$(winpath "$EMPTY_ENV")" -f "$f" config -q; then echo "$f: valid"; else rc=1; fi
  done
  return $rc
}

# deploy/k8s: every overlay renders (Kustomize, as `kubectl apply -k` would), with throwaway placeholder files
# where the real secrets are git-ignored. kubectl comes with Docker Desktop.
k8s_checks() {
  command -v kubectl >/dev/null 2>&1 || { echo "kubectl not found: skipped"; return 0; }
  local tmp rc=0 ov
  tmp=$(mktemp -d)
  cp -r deploy/k8s "$tmp/"
  for ov in "$tmp"/k8s/overlays/*/; do            # placeholders first: one overlay can build on another's
    mkdir -p "$ov/secrets"
    for f in continuum.env pg-gateway.env pg-ca.env pg-passkey.env model-store.env demo.env; do echo "PLACEHOLDER=1" > "$ov/secrets/$f"; done
    echo '{}' > "$ov/secrets/seaweedfs-s3.json"
    : > "$ov/secrets/gateway-verdict-key.pem"; : > "$ov/secrets/gateway-identity-key.pem"
  done
  for ov in "$tmp"/k8s/overlays/*/; do
    if kubectl kustomize "$(winpath "$ov")" > "$tmp/out.yaml"; then
      echo "deploy/k8s/overlays/$(basename "$ov"): renders ($(grep -c '^kind:' "$tmp/out.yaml") resources)"
    else rc=1; fi
  done
  rm -rf "$tmp"
  return $rc
}

DOCKERFILES=(services/ca-service/Dockerfile services/passkey-service/Dockerfile services/gateway/Dockerfile
             apps/demo/Dockerfile services/model-api/Dockerfile.model services/model-api/Dockerfile.model.prod)
hadolint_checks() {
  # Fails on errors only (.hadolint.yaml); warnings are printed.
  docker run --rm -v "$ROOT_D:/repo:ro" -w /repo hadolint/hadolint hadolint --no-color --config .hadolint.yaml "${DOCKERFILES[@]}" \
    && echo "Dockerfiles: no errors"
}

workflow_checks() {
  docker run --rm -v "$ROOT_D:/repo:ro" -w /repo rhysd/actionlint:latest -no-color \
    .github/workflows/ci.yml .github/workflows/publish.yml && echo "workflows: ok"
}

# name | build context | Dockerfile | needs the sdk/ build context | must run as a non-root user
IMAGE_SPECS=(
  "ca-service|services/ca-service|services/ca-service/Dockerfile||nonroot"
  "passkey-service|services/passkey-service|services/passkey-service/Dockerfile||nonroot"
  "gateway|services/gateway|services/gateway/Dockerfile|sdk|nonroot"
  "web-demo|apps/demo|apps/demo/Dockerfile|sdk|nonroot"
  "model-api|.|services/model-api/Dockerfile.model||"
)
# The production model image bakes two datasets that are not in git (so GitHub cannot build it); built
# here when they are present: not root, and only the serving files of services/model-api inside.
MODEL_SERVING_FILES="api.py gunicorn.conf.py loso.py model.py model_store.py preprocessing.py wsgi.py"
if [ -f data/mouse_only/Mouse_A5_W50_base.h5 ] && [ -f data/aalto_neg_A200.h5 ]; then
  IMAGE_SPECS+=("model-api-prod|.|services/model-api/Dockerfile.model.prod||nonroot")
fi
image_checks() {
  local spec name ctx file sdk nonroot tag leaked user rc=0
  for spec in "${IMAGE_SPECS[@]}"; do
    IFS='|' read -r name ctx file sdk nonroot <<<"$spec"
    tag="continuum-ci/$name:local"
    local extra=()
    [ -n "$sdk" ] && extra=(--build-context "sdk=./sdk")
    echo "-- $name: building"
    if ! docker buildx build --quiet --load -t "$tag" -f "$file" ${extra[@]+"${extra[@]}"} "$ctx" >/dev/null; then
      echo "   build FAILED"; rc=1; continue
    fi
    leaked=$(docker run --rm --entrypoint sh "$tag" -c \
      'find / -xdev \( -name "*.pem" -o -name "*.db" -o -name ".env" -o -name tenants.json -o -name accounts.json -o -name identity.json -o -name audit.jsonl \) \
         -not -path "*/node_modules/*" -not -path "/usr/*" -not -path "/etc/*" -not -path "/proc/*" 2>/dev/null' || true)
    if [ -n "$leaked" ]; then
      echo "   secret or state files inside the image:"; echo "$leaked" | sed 's/^/     /'; rc=1
    else
      echo "   built; no secret or state files inside"
    fi
    if [ -n "$nonroot" ]; then
      user=$(docker run --rm --entrypoint id "$tag" -u 2>/dev/null)
      if [ -z "$user" ] || [ "$user" = 0 ]; then echo "   runs as root (uid ${user:-?}): FAILED"; rc=1; else echo "   runs as uid $user, not root"; fi
    fi
    if [ "$name" = model-api-prod ]; then
      local inside
      inside=$(docker run --rm --entrypoint sh "$tag" -c 'cd /app/services/model-api && ls | sort | tr "\n" " "' | sed 's/ $//')
      if [ "$inside" = "$MODEL_SERVING_FILES" ]; then echo "   only the serving files: $inside"
      else echo "   unexpected files in services/model-api: $inside: FAILED"; rc=1; fi
    fi
    if [ "$SCAN" = 1 ]; then
      docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v continuum-trivy-cache:/root/.cache \
        aquasec/trivy:0.56.2 image --quiet --severity CRITICAL,HIGH --ignore-unfixed "$tag" || echo "   (scan could not run)"
    fi
  done
  return $rc
}

step "JavaScript + shell: syntax and unit tests" node_checks
step "Python: syntax and unit tests" python_checks
step "Compose files" compose_checks
step "Kubernetes manifests" k8s_checks
step "Dockerfile lint" hadolint_checks
step "Workflow files" workflow_checks
[ "$IMAGES" = 1 ] && step "Images: build, no secrets inside$([ "$SCAN" = 1 ] && echo ', vulnerability scan')" image_checks

echo; echo "================ summary"
for s in ${passed[@]+"${passed[@]}"}; do echo "  PASS  $s"; done
for s in ${failed[@]+"${failed[@]}"}; do echo "  FAIL  $s"; done
if [ ${#failed[@]} -eq 0 ]; then
  echo "All checks passed."
else
  echo "${#failed[@]} check(s) failed."; exit 1
fi
