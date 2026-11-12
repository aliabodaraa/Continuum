#!/usr/bin/env bash
# Continuum on this PC's Kubernetes: Docker Desktop's built-in cluster (context docker-desktop), in the
# namespaces continuum, continuum-storage and continuum-demo. Nothing else in the cluster is touched, and
# nothing is installed on the PC: kubectl comes with Docker Desktop, Kustomize is part of kubectl, and the
# images are built with Docker, whose image store the cluster runs from.
#
#   scripts/k8s-local.sh platform        once: metrics-server, CloudNativePG, Envoy Gateway (deploy/platform)
#   scripts/k8s-local.sh secrets         once: this cluster's secrets in deploy/k8s/overlays/local/secrets/
#                                        (git-ignored; random, except the operator key, taken from .env)
#   scripts/k8s-local.sh build           the six images from a clean worktree of HEAD, tagged :local and :<commit>
#   scripts/k8s-local.sh deploy          apply the overlay and wait until everything is ready
#   scripts/k8s-local.sh up              build, deploy, and restart the pods on the new images
#   scripts/k8s-local.sh seed-ca <file>  copy a ca-service SQLite file into the cluster's database ca
#                                        (migrate.js: refused if the database already holds rows)
#   scripts/k8s-local.sh operator        the operator page and admin API, which the edge never routes: a
#                                        private port-forward to the gateway on http://localhost:28081
#                                        (open /operator.html there; e2e: CONTINUUM_OPERATOR=that URL)
#   scripts/k8s-local.sh grafana         traces and metrics (Grafana, grafana/otel-lgtm in continuum-observability): a
#                                        private port-forward on http://localhost:3001 (user admin, password in
#                                        deploy/k8s/overlays/local/secrets/grafana.env)
#   scripts/k8s-local.sh e2e [suite...]  the end-to-end suites against this cluster (connect, enrol_reload,
#                                        demo_backend by default; study adds a test participant to the study log,
#                                        so it is run only when named): each makes its own operator port-forward
#   scripts/k8s-local.sh status          pods, services, the edge's address
#   scripts/k8s-local.sh logs <deployment> [namespace]
#   scripts/k8s-local.sh down            delete the namespaces, their data included (asks first)
#
# Two overlays, the same system (namespaces, data, secrets) on different addresses, one at a time:
#   K8S_OVERLAY=local (default)  API http://localhost:28080, demo :23000, Acme :24200, beside the Compose stack
#   K8S_OVERLAY=live             API http://localhost:8080,  demo :3000,  Acme :4200, in place of it (step 9)
set -euo pipefail
cd "$(dirname "$0")/.."
CTX="${K8S_CONTEXT:-docker-desktop}"
case "${K8S_OVERLAY:-local}" in
  local) OVERLAY=deploy/k8s/overlays/local; PORTS=(28080 23000 24200) ;;
  live) OVERLAY=deploy/k8s/overlays/live; PORTS=(8080 3000 4200) ;;
  *) echo "K8S_OVERLAY must be local or live"; exit 2 ;;
esac
SECRETS=deploy/k8s/overlays/local/secrets      # both overlays use these
NAMESPACES=(continuum continuum-storage continuum-demo continuum-observability)
k() { kubectl --context "$CTX" "$@"; }
say() { printf '\n== %s\n' "$*"; }
# Git Bash: no MSYS path rewriting of container paths in kubectl arguments
export MSYS_NO_PATHCONV=1

platform() { kubectl config use-context "$CTX" >/dev/null && bash deploy/platform/install.sh; }

# Grafana's admin password (2026-11-08): random, kept beside the other secrets. Made when missing, so a secrets folder
# from before it gains this one file and nothing else changes.
grafana_secret() {
  mkdir -p "$SECRETS"
  if [ ! -f "$SECRETS/grafana.env" ]; then
    (umask 077; printf 'GF_SECURITY_ADMIN_PASSWORD=%s\n' "$(openssl rand -hex 16)" > "$SECRETS/grafana.env")
    echo "Grafana's admin password written to $SECRETS/grafana.env (git-ignored)"
  fi
  # The token Grafana's alerts carry to scripts/alert-notifier.ps1 on this PC (2026-11-12).
  if ! grep -q '^CONTINUUM_ALERT_TOKEN=' "$SECRETS/grafana.env"; then
    printf 'CONTINUUM_ALERT_TOKEN=%s\n' "$(openssl rand -hex 24)" >> "$SECRETS/grafana.env"
    echo "the alerts' token added to $SECRETS/grafana.env (git-ignored)"
  fi
}

secrets() {
  grafana_secret
  if [ -f "$SECRETS/continuum.env" ]; then echo "$SECRETS already exists; delete it to make new secrets"; return 0; fi
  mkdir -p "$SECRETS"
  umask 077
  rnd() { openssl rand -hex 32; }
  local admin signing s3secret
  admin=$(grep -E '^GATEWAY_ADMIN_KEY=' .env 2>/dev/null | head -1 | cut -d= -f2- || true)
  [ -n "$admin" ] || admin=$(rnd)
  signing=$(rnd)
  s3secret=$(rnd)
  # TEXT_HASH_SALT stays the services' default so samples copied from this checkout (seed-ca) compare equal.
  cat > "$SECRETS/continuum.env" <<EOF
CA_SIGNING_SECRET=$signing
GATEWAY_SESSION_SECRET=$(rnd)
GATEWAY_ADMIN_KEY=$admin
MODEL_API_KEY=$(rnd)
CA_API_KEY=$(rnd)
PASSKEY_API_KEY=$(rnd)
TEXT_HASH_SALT=continuum-text-hash-salt
EOF
  for svc in gateway ca passkey; do
    printf 'username=%s\npassword=%s\n' "$svc" "$(openssl rand -hex 24)" > "$SECRETS/pg-$svc.env"
  done
  printf 'MODEL_S3_ACCESS_KEY=continuum-models\nMODEL_S3_SECRET_KEY=%s\n' "$s3secret" > "$SECRETS/model-store.env"
  cat > "$SECRETS/seaweedfs-s3.json" <<EOF
{"identities": [{"name": "model-service", "credentials": [{"accessKey": "continuum-models", "secretKey": "$s3secret"}],
  "actions": ["Admin", "Read", "Write", "List", "Tagging"]}]}
EOF
  # the demo tenant (pk_demo) signs its users' identities with the gateway's CA_SIGNING_SECRET
  printf 'SESSION_SECRET=%s\nCONTINUUM_SECRET=%s\n' "$(rnd)" "$signing" > "$SECRETS/demo.env"
  for key in gateway-verdict-key gateway-identity-key; do
    openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$SECRETS/$key.pem" 2>/dev/null
  done
  echo "secrets written to $SECRETS (git-ignored)"
}

# The images are built from a clean worktree of the current commit (2026-11-08), tagged :local and :<commit>, and
# labelled with it (org.opencontainers.image.revision): the running code is always a commit, uncommitted edits never
# reach the cluster by accident, and an older :<commit> tag is an undo (docker tag it :local, restart the deployment).
# The model image's data files, which git does not hold, are copied in after their pinned SHA-256 is checked
# (scripts/lib/model-inputs.sh). BUILD_FROM=working builds the working tree as it is instead, labelled
# <commit>-dirty when files under the build contexts differ from the commit.
build() {
  local here rev dirty src
  here=$(pwd)
  source scripts/lib/model-inputs.sh
  rev=$(git rev-parse --short=12 HEAD)
  dirty=$(git status --porcelain --untracked-files=no -- services apps sdk artifacts)
  if [ "${BUILD_FROM:-commit}" = working ]; then
    src=.
    if [ -n "$dirty" ]; then
      rev="$rev-dirty"
      echo "WARNING: building the working tree: these uncommitted changes go into the images:" >&2
      echo "$dirty" | sed 's/^/   /' >&2
    fi
  else
    src=$(mktemp -d "${TMPDIR:-/tmp}/continuum-build-XXXXXX")
    git worktree add -q --detach "$src" HEAD
    model_inputs_copy . "$src"
    if [ -n "$dirty" ]; then
      echo "note: building commit $rev; these uncommitted changes are NOT in the images (BUILD_FROM=working includes them):" >&2
      echo "$dirty" | sed 's/^/   /' >&2
    fi
  fi
  drop_src() { [ "$src" = . ] || (cd "$here" && git worktree remove --force "$src"); }
  if ! model_inputs_check "$src"; then
    echo "build refused: the model image's data files above are missing or changed; restore them with" \
      "scripts/k8s-restore.sh <backup> --build-inputs" >&2
    drop_src; exit 1
  fi
  say "building the images (:local and :$rev) from $([ "$src" = . ] && echo "the working tree" || echo "commit $rev")"
  local L="--label org.opencontainers.image.revision=$rev"
  if ! (cd "$src" &&
    docker build -q $L -t continuum/gateway:local -t "continuum/gateway:$rev" --build-context sdk=./sdk services/gateway &&
    docker build -q $L -t continuum/ca-service:local -t "continuum/ca-service:$rev" services/ca-service &&
    docker build -q $L -t continuum/passkey-service:local -t "continuum/passkey-service:$rev" services/passkey-service &&
    docker build -q $L -t continuum/web-demo:local -t "continuum/web-demo:$rev" --build-context sdk=./sdk apps/demo &&
    docker build -q $L -t continuum/acme:local -t "continuum/acme:$rev" apps/acme &&
    docker build -q $L -t continuum/model-api:local -t "continuum/model-api:$rev" -f services/model-api/Dockerfile.model.prod .); then
    drop_src; echo "build failed: see above" >&2; exit 1
  fi
  drop_src
  # No image may carry secrets, databases or backups (scripts/lib/scan-image.sh).
  source scripts/lib/scan-image.sh
  scan_image continuum/gateway:local continuum/ca-service:local continuum/passkey-service:local \
    continuum/web-demo:local continuum/acme:local continuum/model-api:local || { echo "build refused: see above" >&2; exit 1; }
}

wait_ready() {
  say "waiting for PostgreSQL"
  k -n continuum wait --for=condition=Ready cluster/continuum-pg --timeout=600s
  for ns in "${NAMESPACES[@]}"; do
    for d in $(k -n "$ns" get deploy -o name); do
      if [ "$ns" = continuum-observability ]; then
        # Not part of the product: its image is large, and a slow connection must not hold up or fail a deployment.
        k -n "$ns" rollout status "$d" --timeout=120s || echo "note: $d is not ready yet; the product does not depend on it (it starts when its image has arrived)"
      else
        k -n "$ns" rollout status "$d" --timeout=600s
      fi
    done
  done
}

deploy() {
  [ -f "$SECRETS/continuum.env" ] || { echo "no secrets yet: run $0 secrets first"; exit 1; }
  grafana_secret
  say "applying $OVERLAY"
  k apply -k "$OVERLAY"
  wait_ready
  status
}

up() {
  build
  [ -f "$SECRETS/continuum.env" ] || secrets
  grafana_secret
  k apply -k "$OVERLAY"
  # same tag, new image: restart the pods so they run it
  for ns in "${NAMESPACES[@]}"; do
    # (the object store and the telemetry stack keep running: their images did not change; grep may find
    # nothing in their namespaces, which is not an error)
    k -n "$ns" get deploy -o name | { grep -v -e seaweedfs -e otel-lgtm || true; } | xargs -r kubectl --context "$CTX" -n "$ns" rollout restart
  done
  wait_ready
  status
}

seed_ca() {
  local file="${1:?usage: $0 seed-ca <ca.db>}"
  [ -f "$file" ] || { echo "no such file: $file"; exit 1; }
  say "copying $file into the database ca (a one-off pod from the ca-service image)"
  k -n continuum delete pod ca-seed --ignore-not-found --wait=true >/dev/null
  k -n continuum apply -f - <<'EOF'
apiVersion: v1
kind: ServiceAccount
metadata:
  name: db-migrate
automountServiceAccountToken: false
---
apiVersion: v1
kind: Pod
metadata:
  name: ca-seed
  labels: { app.kubernetes.io/name: db-migrate }
spec:
  serviceAccountName: db-migrate      # the identity the mesh lets reach the database (base/continuum/mesh-policies.yaml)
  restartPolicy: Never
  automountServiceAccountToken: false
  enableServiceLinks: false
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    runAsGroup: 1000
    seccompProfile: { type: RuntimeDefault }
  containers:
    - name: seed
      image: continuum/ca-service:local
      command: ["sleep", "3600"]
      env:
        - name: DB_USER
          valueFrom: { secretKeyRef: { name: pg-ca, key: username } }
        - name: DB_PASSWORD
          valueFrom: { secretKeyRef: { name: pg-ca, key: password } }
        - { name: DATABASE_URL, value: "postgres://$(DB_USER):$(DB_PASSWORD)@continuum-pg-rw:5432/ca" }
      resources:
        requests: { cpu: 100m, memory: 256Mi }
        limits: { memory: 1Gi }
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities: { drop: ["ALL"] }
      volumeMounts:
        - { name: work, mountPath: /work }
        - { name: tmp, mountPath: /tmp }
  volumes:
    - { name: work, emptyDir: {} }
    - { name: tmp, emptyDir: {} }
EOF
  k -n continuum wait --for=condition=Ready pod/ca-seed --timeout=180s
  k -n continuum cp "$file" ca-seed:/work/ca.db
  k -n continuum exec ca-seed -- sh -c 'node migrate.js --from /work/ca.db --to "$DATABASE_URL"'
  k -n continuum delete pod ca-seed --wait=false >/dev/null
}

status() {
  for ns in "${NAMESPACES[@]}"; do say "$ns"; k -n "$ns" get pods,svc 2>/dev/null || true; done
  say "edge"
  k get gateway -A 2>/dev/null || true
  echo "API  http://localhost:${PORTS[0]}    demo http://localhost:${PORTS[1]}    Acme http://localhost:${PORTS[2]}    ($OVERLAY)"
}

logs() { k -n "${2:-continuum}" logs "deploy/${1:?usage: $0 logs <deployment> [namespace]}" --tail=200; }

operator() {
  echo "operator page: http://localhost:28081/operator.html   (Ctrl-C ends it; it follows the gateway to a new pod)"
  # A port-forward is tied to one pod: after a restart it fails a request before it notices. So follow the
  # gateway: every 2 s, the ready pod that is not shutting down; when it changes, forward to the new one.
  local pod="" now pf="" log
  log=$(mktemp)
  trap '[ -n "$pf" ] && kill "$pf" 2>/dev/null; rm -f "$log"; exit 0' INT TERM
  while true; do
    now=$(k -n continuum get pod -l app.kubernetes.io/name=gateway \
            -o jsonpath='{range .items[*]}{.metadata.name} {.metadata.deletionTimestamp} {.status.containerStatuses[0].ready}{"\n"}{end}' 2>/dev/null \
          | awk 'NF == 2 && $2 == "true" { print $1; exit }' || true)
    if [ -n "$now" ] && { [ "$now" != "$pod" ] || ! kill -0 "$pf" 2>/dev/null; }; then
      if [ -n "$pf" ]; then
        kill -0 "$pf" 2>/dev/null || echo "$(date +%T) the forward ended: $(grep -v '^Handling' "$log" | tail -1)"
        kill "$pf" 2>/dev/null || true; wait "$pf" 2>/dev/null || true
        sleep 1                                   # Windows frees the old listener a moment after its process ends
      fi
      pod=$now
      # kubectl itself in the background (not through k(): a function runs in a subshell, and killing that
      # would leave the old kubectl holding the port)
      kubectl --context "$CTX" -n continuum port-forward "pod/$pod" 28081:8080 --address 127.0.0.1 >"$log" 2>&1 & pf=$!
      echo "$(date +%T) forwarding to $pod"
    fi
    sleep 2
  done
}

grafana() {
  echo "Grafana: http://localhost:3001  (user admin, password: the value in $SECRETS/grafana.env; Ctrl-C ends it)."
  echo "Explore > Tempo for traces, Prometheus for metrics."
  k -n continuum-observability port-forward deploy/otel-lgtm 3001:3000 --address 127.0.0.1
}

# The suites run from this checkout against this cluster: the live addresses of the overlay, the overlay's
# secrets, kubectl exec where they look inside a service (extension/scripts/lib/stack.mjs).
e2e() {
  local suites=("$@") s rc=0
  [ ${#suites[@]} -gt 0 ] || suites=(connect enrol_reload demo_backend)
  for s in "${suites[@]}"; do
    say "e2e_headless_$s"
    CONTINUUM_K8S_CONTEXT="$CTX" CONTINUUM_GATEWAY="http://localhost:${PORTS[0]}" CONTINUUM_DEMO="http://localhost:${PORTS[1]}" \
      node "extension/scripts/e2e_headless_$s.mjs" || rc=1
  done
  return $rc
}

down() {
  read -r -p "Delete namespaces ${NAMESPACES[*]} and ALL their data (databases, model store)? [y/N] " a
  [ "$a" = y ] || { echo "nothing deleted"; return 0; }
  k delete namespace "${NAMESPACES[@]}" --ignore-not-found
}

case "${1:-}" in
  platform) platform ;;
  secrets) secrets ;;
  build) build ;;
  deploy) deploy ;;
  up) up ;;
  seed-ca) shift; seed_ca "$@" ;;
  status) status ;;
  operator) operator ;;
  grafana) grafana ;;
  e2e) shift; e2e "$@" ;;
  logs) shift; logs "$@" ;;
  down) down ;;
  *) sed -n '2,30p' "$0"; exit 2 ;;
esac
