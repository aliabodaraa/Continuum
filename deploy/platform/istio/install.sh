#!/usr/bin/env bash
# Istio in ambient mode: mutual TLS between Continuum's services, and who may call whom by workload identity
# (mesh-policies.yaml in deploy/k8s/base/*). Nothing is added to our pods, so the "restricted" pod rule still holds.
# Rendered from Istio's own Helm charts at a pinned version by a throwaway Helm container and applied, so neither Helm
# nor istioctl is installed. On Docker Desktop the files in docker-desktop/ go on top; each says why.
#
#   deploy/platform/istio/install.sh           (kubectl's current context; deploy/platform/install.sh calls it)
#   DRY_RUN=1 deploy/platform/istio/install.sh only shows what would change on the cluster
set -euo pipefail

ISTIO_VERSION=1.31.4
HELM_IMAGE=alpine/helm:3.16.2
CHARTS=https://blob.istio.io/istio-release/charts      # the older storage.googleapis.com repository stops at 1.30.8

here="$(cd "$(dirname "$0")" && pwd)"
in_container="$(cd "$here" && { pwd -W 2>/dev/null || pwd; })"     # Git Bash: Docker needs the Windows path
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT

dd_cni=(); dd_istiod=(); dd_ztunnel=(); docker_desktop=0
if [ "$(kubectl config current-context)" = "docker-desktop" ]; then
  docker_desktop=1
  dd_cni=(-f /in/docker-desktop/values-cni.yaml)
  dd_istiod=(-f /in/docker-desktop/values-istiod.yaml)
  dd_ztunnel=(-f /in/docker-desktop/values-ztunnel.yaml)
fi

render() {   # release chart [helm arguments]: writes $out/<release>.yaml
  local release=$1 chart=$2; shift 2
  MSYS_NO_PATHCONV=1 docker run --rm -v "$in_container:/in:ro" "$HELM_IMAGE" template "$release" "$chart" \
    --repo "$CHARTS" --version "$ISTIO_VERSION" -n istio-system "$@" > "$out/$release.yaml"
}

render istio-base base
render istiod istiod --set profile=ambient -f /in/values-istiod.yaml "${dd_istiod[@]}"
render istio-cni cni --set profile=ambient "${dd_cni[@]}"
render ztunnel ztunnel -f /in/values-ztunnel.yaml "${dd_ztunnel[@]}"

if [ "$docker_desktop" = 1 ]; then
  mkdir "$out/cni"
  mv "$out/istio-cni.yaml" "$out/cni/istio-cni.yaml"
  cp "$here/docker-desktop/run-shared-patch.yaml" "$out/cni/"
  printf 'resources:\n  - istio-cni.yaml\npatches:\n  - path: run-shared-patch.yaml\n' > "$out/cni/kustomization.yaml"
  kubectl kustomize "$out/cni" > "$out/istio-cni.yaml"
fi

if [ "${DRY_RUN:-0}" = 1 ]; then
  for f in istio-base istiod istio-cni ztunnel; do
    echo "== $f"
    kubectl diff --server-side --force-conflicts -f "$out/$f.yaml" || true
  done
  exit 0
fi

kubectl create namespace istio-system --dry-run=client -o yaml | kubectl apply -f -
# --force-conflicts: istiod itself updates fields of its webhook after start.
for f in istio-base istiod istio-cni ztunnel; do
  kubectl apply --server-side --force-conflicts -f "$out/$f.yaml"
done
