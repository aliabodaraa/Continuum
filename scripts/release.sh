#!/usr/bin/env bash
# Continuum — build and publish all service images to a container registry.
#
# Usage:
#   REGISTRY=<dockerhub-user> TAG=0.1.0 ./scripts/release.sh
#   REGISTRY=ghcr.io/<owner>  TAG=0.1.0 ./scripts/release.sh
#
# Prerequisites: `docker login <registry>` already done, Docker running.
# Publishes: model-api, ca-service, passkey-service, gateway (the product bundle)
# plus web-demo (the reference demo app). Each is tagged ${REGISTRY}/<svc>:${TAG}
# and also :latest.
set -euo pipefail

cd "$(dirname "$0")/.."

REGISTRY="${REGISTRY:-}"
TAG="${TAG:-}"

if [ -z "$REGISTRY" ] || [ "$REGISTRY" = "continuum" ]; then
  echo "ERROR: set REGISTRY to a namespace you can push to (Docker Hub user or ghcr.io/<owner>)." >&2
  echo "  e.g.  REGISTRY=myuser TAG=0.1.0 ./scripts/release.sh" >&2
  exit 1
fi
if [ -z "$TAG" ] || [ "$TAG" = "latest" ]; then
  echo "ERROR: set TAG to an explicit version (not 'latest') for a reproducible release." >&2
  echo "  e.g.  REGISTRY=$REGISTRY TAG=0.1.0 ./scripts/release.sh" >&2
  exit 1
fi

export REGISTRY TAG
echo ">> Publishing Continuum images to ${REGISTRY} at tag ${TAG}"

# 1) The product bundle: model-api, ca-service, passkey-service, gateway.
echo ">> Building bundle images…"
docker compose -f docker-compose.bundle.yml build
echo ">> Pushing bundle images…"
docker compose -f docker-compose.bundle.yml push

# 2) The reference demo web app (shares the same service images; only web-demo
#    is unique to the demo stack).
echo ">> Building + pushing web-demo…"
docker compose -f docker-compose.prod.yml build web
docker compose -f docker-compose.prod.yml push web

# 3) Also move the floating :latest tag to this build, for convenience pulls.
for svc in model-api ca-service passkey-service gateway web-demo; do
  docker tag "${REGISTRY}/${svc}:${TAG}" "${REGISTRY}/${svc}:latest"
  docker push "${REGISTRY}/${svc}:latest"
done

echo ">> Done. Customers pull with:  REGISTRY=${REGISTRY} TAG=${TAG} docker compose -f docker-compose.bundle.yml pull"
