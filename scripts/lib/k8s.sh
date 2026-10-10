# Shared by scripts/k8s-import.sh, k8s-backup.sh and k8s-restore.sh (sourced, not run): the cluster of
# scripts/k8s-local.sh, one-off pods, the PostgreSQL primary, the demo's volume.
CTX="${K8S_CONTEXT:-docker-desktop}"
k() { kubectl --context "$CTX" "$@"; }
say() { printf '\n== %s\n' "$*"; }
export MSYS_NO_PATHCONV=1           # Git Bash: no path rewriting of container paths in kubectl arguments
# a local folder as `docker run -v` wants it (a Windows path under Git Bash)
winpath() { if command -v cygpath >/dev/null; then cygpath -w "$1"; else printf '%s' "$1"; fi; }

# One-off pods are deleted when the script ends (oneoff_cleanup, from the caller's EXIT trap).
ONEOFF_PODS=()
oneoff_cleanup() {
  local p
  for p in "${ONEOFF_PODS[@]}"; do k -n "${p%%/*}" delete pod "${p#*/}" --wait=false >/dev/null 2>&1 || true; done
}

# A one-off pod (restricted, like the services) from a service's image, optionally with that service's
# database (DATABASE_URL, from its PostgreSQL secret), and /work, /tmp to work in.
oneoff() {  # ns name image [pg-secret db]
  local ns=$1 name=$2 image=$3 secret=${4:-} db=${5:-} env=""
  [ -n "$secret" ] && env="        - name: DB_USER
          valueFrom: { secretKeyRef: { name: $secret, key: username } }
        - name: DB_PASSWORD
          valueFrom: { secretKeyRef: { name: $secret, key: password } }
        - { name: DATABASE_URL, value: \"postgres://\$(DB_USER):\$(DB_PASSWORD)@continuum-pg-rw.continuum:5432/$db\" }"
  k -n "$ns" delete pod "$name" --ignore-not-found --wait=true >/dev/null
  k -n "$ns" apply -f - >/dev/null <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: $name
  labels: { app.kubernetes.io/name: db-migrate }
spec:
  restartPolicy: Never
  automountServiceAccountToken: false
  enableServiceLinks: false
  securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000, seccompProfile: { type: RuntimeDefault } }
  containers:
    - name: work
      image: $image
      command: ["sleep", "7200"]
      env:
        - { name: HOME, value: /tmp }
$env
      resources: { requests: { cpu: 100m, memory: 256Mi }, limits: { memory: 2Gi } }
      securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } }
      volumeMounts: [{ name: work, mountPath: /work }, { name: tmp, mountPath: /tmp }]
  volumes: [{ name: work, emptyDir: {} }, { name: tmp, emptyDir: {} }]
EOF
  ONEOFF_PODS+=("$ns/$name")
  k -n "$ns" wait --for=condition=Ready "pod/$name" --timeout=300s >/dev/null
}

# The PostgreSQL primary's pod, and a command in it as the database superuser (local socket).
pg_primary() { k -n continuum get pod -l cnpg.io/cluster=continuum-pg,cnpg.io/instanceRole=primary -o jsonpath='{.items[0].metadata.name}'; }
pg_exec() { k -n continuum exec -i "$(pg_primary)" -c postgres -- "$@"; }

# The demo's users and uploads onto its volume, replacing what it held: the demo is stopped meanwhile (one
# SQLite file, one writer) and started again with as many copies as before. Checked by SHA-256.
demo_put() {  # <folder holding continuum.db> [uploads folder]
  local dbdir=$1 uploads=${2:-} copies want got
  copies=$(k -n continuum-demo get deploy/web -o jsonpath='{.spec.replicas}')
  k -n continuum-demo scale deploy/web --replicas=0 >/dev/null
  k -n continuum-demo wait --for=delete pod -l app.kubernetes.io/name=web --timeout=120s >/dev/null 2>&1 || true
  k -n continuum-demo delete pod demo-files --ignore-not-found --wait=true >/dev/null
  k -n continuum-demo apply -f - >/dev/null <<'EOF'
apiVersion: v1
kind: Pod
metadata: { name: demo-files }
spec:
  restartPolicy: Never
  automountServiceAccountToken: false
  securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000, seccompProfile: { type: RuntimeDefault } }
  containers:
    - name: work
      image: continuum/web-demo:local
      command: ["sleep", "3600"]
      resources: { requests: { cpu: 50m, memory: 64Mi }, limits: { memory: 256Mi } }
      securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } }
      volumeMounts: [{ name: data, mountPath: /data }]
  volumes: [{ name: data, persistentVolumeClaim: { claimName: demo-data } }]
EOF
  ONEOFF_PODS+=("continuum-demo/demo-files")
  k -n continuum-demo wait --for=condition=Ready pod/demo-files --timeout=180s >/dev/null
  (cd "$dbdir" && tar -cf - continuum.db) | k -n continuum-demo exec -i demo-files -- sh -c \
    'mkdir -p /data/db && rm -f /data/db/continuum.db-wal /data/db/continuum.db-shm && tar -xf - -C /data/db'
  if [ -n "$uploads" ] && [ -d "$uploads" ]; then
    (cd "$uploads" && tar -cf - .) | k -n continuum-demo exec -i demo-files -- sh -c \
      'rm -rf /data/uploads && mkdir -p /data/uploads && tar -xf - -C /data/uploads'
  fi
  want=$(cd "$dbdir" && sha256sum continuum.db | cut -d' ' -f1)
  got=$(k -n continuum-demo exec demo-files -- sha256sum /data/db/continuum.db | cut -d' ' -f1)
  k -n continuum-demo delete pod demo-files --wait=true >/dev/null
  k -n continuum-demo scale deploy/web --replicas="${copies:-1}" >/dev/null
  k -n continuum-demo rollout status deploy/web --timeout=300s
  [ "$want" = "$got" ] && echo "demo users: in place, identical (sha256 ${got:0:12})" || { echo "demo users: NOT identical"; return 1; }
}
