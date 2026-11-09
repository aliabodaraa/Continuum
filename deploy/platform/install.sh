#!/usr/bin/env bash
# The cluster-wide pieces Continuum runs on, at pinned versions. Idempotent: run it again to upgrade after
# changing a version here. Installs only from each project's own release manifest (no Helm needed):
#   metrics-server   resource metrics for the HorizontalPodAutoscalers
#   CloudNativePG    the PostgreSQL operator (namespace cnpg-system)
#   Envoy Gateway    the Gateway API implementation at the edge (namespace envoy-gateway-system),
#                    and the GatewayClass "envoy" every Gateway uses
#   Istio            mutual TLS between the services, ambient mode (namespace istio-system; istio/install.sh)
# Everything is applied first and waited for at the end, so a slow image download cannot leave a step out
# (the pods start whenever their images arrive).
#
#   deploy/platform/install.sh                 (kubectl's current context; scripts/k8s-local.sh calls it)
set -euo pipefail

METRICS_SERVER_VERSION=v0.9.0
CNPG_VERSION=1.30.1
ENVOY_GATEWAY_VERSION=v1.9.2

say() { printf '\n== %s\n' "$*"; }

say "metrics-server $METRICS_SERVER_VERSION"
kubectl apply -f "https://github.com/kubernetes-sigs/metrics-server/releases/download/$METRICS_SERVER_VERSION/components.yaml"
# Docker Desktop's kubelet serves a self-signed certificate: metrics-server must not verify it there.
if [ "$(kubectl config current-context)" = "docker-desktop" ]; then
  kubectl -n kube-system get deploy metrics-server -o jsonpath='{.spec.template.spec.containers[0].args}' | grep -q -- --kubelet-insecure-tls \
    || kubectl -n kube-system patch deploy metrics-server --type=json \
         -p '[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'
fi

say "CloudNativePG $CNPG_VERSION"
kubectl apply --server-side -f \
  "https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/release-${CNPG_VERSION%.*}/releases/cnpg-$CNPG_VERSION.yaml"

say "Envoy Gateway $ENVOY_GATEWAY_VERSION (with the Gateway API resources) and the GatewayClass envoy"
kubectl apply --server-side -f "https://github.com/envoyproxy/gateway/releases/download/$ENVOY_GATEWAY_VERSION/install.yaml"
kubectl apply -f "$(dirname "$0")/gatewayclass.yaml"

say "Istio (ambient), and the edge and the database operator in the mesh: strict namespaces accept nothing from outside it"
bash "$(dirname "$0")/istio/install.sh"
kubectl label namespace envoy-gateway-system cnpg-system istio.io/dataplane-mode=ambient --overwrite

say "waiting for the operators (their images may take a while on a slow connection)"
ok=1
kubectl -n kube-system rollout status deploy/metrics-server --timeout=600s || ok=0
kubectl -n cnpg-system rollout status deploy/cnpg-controller-manager --timeout=600s || ok=0
kubectl -n envoy-gateway-system rollout status deploy/envoy-gateway --timeout=600s || ok=0
kubectl -n istio-system rollout status deploy/istiod --timeout=600s || ok=0
kubectl -n istio-system rollout status ds/istio-cni-node --timeout=600s || ok=0
kubectl -n istio-system rollout status ds/ztunnel --timeout=600s || ok=0
if [ "$ok" = 1 ]; then say "platform ready"; else say "applied; some pods are not ready yet (kubectl get pods -A): they start when their images arrive"; fi
