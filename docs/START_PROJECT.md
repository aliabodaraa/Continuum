# Start Continuum

The live system on this PC is the Kubernetes cluster of Docker Desktop (since 2026-10-10): namespaces
`continuum`, `continuum-storage`, `continuum-demo` and `continuum-observability`. Nothing is installed on the
PC beyond Docker Desktop. From Git Bash, in this checkout:

```bash
scripts/k8s-local.sh status                 # is it up? (pods, services, the edge's address)
K8S_OVERLAY=live scripts/k8s-local.sh up    # after a code change: build the images, deploy, restart, wait
scripts/k8s-local.sh logs gateway           # a service's log (ca-service, passkey-service, model-inference, ...)
scripts/k8s-local.sh operator               # the operator page: http://localhost:28081/operator.html
scripts/k8s-local.sh grafana                # traces and metrics: http://localhost:3001 (user admin, password in deploy/k8s/overlays/local/secrets/grafana.env)
scripts/k8s-local.sh e2e                    # the end-to-end suites against the cluster
scripts/k8s-backup.sh                       # a backup (before any change; keep copies off the PC encrypted)
```

Open:

- the API and the extension's pages: http://localhost:8080 (console: `/console.html`)
- the demo: http://localhost:3000
- Acme: http://localhost:4200

The pods start by themselves after Docker Desktop starts (they wait for PostgreSQL). A fresh PC:
`scripts/k8s-local.sh platform`, then `k8s-restore.sh <backup> --secrets`, then `K8S_OVERLAY=live
scripts/k8s-local.sh up` and `k8s-restore.sh <backup> --restore` (DEPLOY.md, "Kubernetes on this PC").

For development with bind mounts and hot reload there is still `docker-compose.yml`
(`docker compose --profile model up -d`, on 8080/3000/4200: stop the cluster's edge first or use the
`local` overlay on 28080/23000/24200). The single-host product bundle is `docker-compose.bundle.yml`.
