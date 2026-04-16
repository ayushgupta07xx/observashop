#!/usr/bin/env bash
#
# bootstrap.sh — one-command local recreate of the ObservaShop stack.
#
# What this does:
#   1. Verifies prerequisites (docker, kind, kubectl, helm)
#   2. Creates a 3-node kind cluster named 'observashop'
#   3. Spins up a local image registry (localhost:5001) wired into kind
#      — including the two-part containerd config fix (see CLAUDE_CONTEXT.md gotcha #3)
#   4. Builds and pushes the 3 service images to the local registry
#   5. Installs Postgres via the Bitnami chart, creates 'orders' DB
#   6. Deploys users, products, orders services via the reusable Helm chart
#   7. Installs observability: kube-prometheus-stack + Loki v3 + Promtail
#   8. Applies Grafana dashboards and PrometheusRules
#   9. Installs ArgoCD and applies the 3 Application CRDs
#
# Total time on a clean machine: ~10 minutes.
# Idempotent: safe to re-run. Existing resources are upgraded in place.
#
# Usage:
#   ./bootstrap.sh

set -euo pipefail

# -------------------------------------------------------------------
# Configuration
# -------------------------------------------------------------------
CLUSTER_NAME="observashop"
KIND_CONFIG="infra/kind/cluster.yaml"
REGISTRY_NAME="kind-registry"
REGISTRY_PORT="5001"
ARGOCD_VERSION="v2.13.1"

NAMESPACES=("observashop" "monitoring" "argocd")
SERVICES=("users-service" "products-service" "orders-service")

# -------------------------------------------------------------------
# Helpers
# -------------------------------------------------------------------
log()  { printf '\033[1;34m▸\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m⚠\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

require() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command not found: $1"
}

# -------------------------------------------------------------------
# 0. Prerequisites
# -------------------------------------------------------------------
log "Checking prerequisites"
for cmd in docker kind kubectl helm; do require "$cmd"; done
docker info >/dev/null 2>&1 || fail "Docker is not running. Start Docker Desktop and retry."
[ -f "${KIND_CONFIG}" ] || fail "kind config not found at ${KIND_CONFIG} — run from repo root."

# -------------------------------------------------------------------
# 1. kind cluster
# -------------------------------------------------------------------
if kind get clusters 2>/dev/null | grep -q "^${CLUSTER_NAME}$"; then
  log "kind cluster '${CLUSTER_NAME}' already exists — skipping creation"
else
  log "Creating kind cluster '${CLUSTER_NAME}'"
  kind create cluster --name "${CLUSTER_NAME}" --config "${KIND_CONFIG}"
fi

# -------------------------------------------------------------------
# 2. Local image registry (localhost:5001) wired into kind
# -------------------------------------------------------------------
if [ "$(docker inspect -f '{{.State.Running}}' "${REGISTRY_NAME}" 2>/dev/null || true)" != "true" ]; then
  log "Starting local registry '${REGISTRY_NAME}' on :${REGISTRY_PORT}"
  docker run -d --restart=always \
    -p "127.0.0.1:${REGISTRY_PORT}:5000" \
    --name "${REGISTRY_NAME}" \
    registry:2 >/dev/null
else
  log "Local registry '${REGISTRY_NAME}' already running"
fi

# Connect registry to the kind network (no-op if already connected)
if ! docker network inspect kind -f '{{range .Containers}}{{.Name}} {{end}}' | grep -q "${REGISTRY_NAME}"; then
  log "Connecting '${REGISTRY_NAME}' to the 'kind' Docker network"
  docker network connect kind "${REGISTRY_NAME}" 2>/dev/null || true
fi

# Containerd setup: tell every node that localhost:5001 -> kind-registry:5000
# Both hosts.toml AND main config.toml's config_path are required (gotcha #3).
log "Configuring containerd on kind nodes"
for node in $(kind get nodes --name "${CLUSTER_NAME}"); do
  docker exec "${node}" mkdir -p "/etc/containerd/certs.d/localhost:${REGISTRY_PORT}"
  cat <<EOF | docker exec -i "${node}" sh -c "cat > /etc/containerd/certs.d/localhost:${REGISTRY_PORT}/hosts.toml"
[host."http://${REGISTRY_NAME}:5000"]
  capabilities = ["pull", "resolve"]
EOF

  if ! docker exec "${node}" grep -q 'config_path = "/etc/containerd/certs.d"' /etc/containerd/config.toml; then
    docker exec "${node}" sh -c 'cat >> /etc/containerd/config.toml <<EOF

[plugins."io.containerd.grpc.v1.cri".registry]
  config_path = "/etc/containerd/certs.d"
EOF
systemctl restart containerd'
  fi
done

# -------------------------------------------------------------------
# 3. Namespaces
# -------------------------------------------------------------------
for ns in "${NAMESPACES[@]}"; do
  if ! kubectl get namespace "${ns}" >/dev/null 2>&1; then
    log "Creating namespace '${ns}'"
    kubectl create namespace "${ns}"
  fi
done

# -------------------------------------------------------------------
# 4. Build and push service images
# -------------------------------------------------------------------
for svc in "${SERVICES[@]}"; do
  # Read the image tag from the per-service Helm values file so the built
  # image matches exactly what the chart will try to pull.
  tag=$(sed -nE 's/^[[:space:]]*tag:[[:space:]]*"?([^"[:space:]]+)"?.*$/\1/p' \
          "charts/values/${svc}.yaml" | head -1)
  [ -n "${tag}" ] || fail "Could not read image tag from charts/values/${svc}.yaml"
  image="localhost:${REGISTRY_PORT}/observashop/${svc}:${tag}"
  log "Building ${svc} -> ${image}"
  docker build -q -t "${image}" "services/${svc}" >/dev/null
  docker push -q "${image}" >/dev/null
done

# -------------------------------------------------------------------
# 5. Helm repos
# -------------------------------------------------------------------
log "Adding / updating Helm repos"
helm repo add bitnami              https://charts.bitnami.com/bitnami             --force-update >/dev/null
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts --force-update >/dev/null
helm repo add grafana              https://grafana.github.io/helm-charts          --force-update >/dev/null
helm repo update >/dev/null

# -------------------------------------------------------------------
# 6. Postgres
# -------------------------------------------------------------------
log "Installing Postgres (Bitnami)"
helm upgrade --install postgres bitnami/postgresql \
  --namespace observashop \
  --set auth.username=observashop \
  --set auth.password=observashop-dev-pw \
  --set auth.database=users \
  --set primary.persistence.size=1Gi \
  --wait --timeout 5m

log "Ensuring 'orders' database exists"
if ! kubectl exec -n observashop postgres-postgresql-0 -- \
       env PGPASSWORD=observashop-dev-pw psql -U observashop -d users -tAc \
       "SELECT 1 FROM pg_database WHERE datname='orders'" | grep -q 1; then
  kubectl exec -n observashop postgres-postgresql-0 -- \
    env PGPASSWORD=observashop-dev-pw psql -U observashop -d users -c \
    "CREATE DATABASE orders"
fi

# -------------------------------------------------------------------
# 7. Services (single reusable Helm chart, per-service values)
# -------------------------------------------------------------------
for svc in "${SERVICES[@]}"; do
  log "Installing ${svc}"
  helm upgrade --install "${svc}" ./charts/microservice \
    -f "charts/values/${svc}.yaml" \
    --namespace observashop \
    --wait --timeout 3m
done

# -------------------------------------------------------------------
# 8. Observability: kube-prometheus-stack, Loki (v3), Promtail
# -------------------------------------------------------------------
log "Installing kube-prometheus-stack"
helm upgrade --install kps prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  -f charts/values/kube-prometheus-stack.yaml \
  --wait --timeout 10m

log "Installing Loki (modern single-binary v3 chart)"
helm upgrade --install loki grafana/loki \
  --namespace monitoring \
  -f charts/values/loki.yaml \
  --wait --timeout 5m

log "Installing Promtail"
helm upgrade --install promtail grafana/promtail \
  --namespace monitoring \
  -f charts/values/promtail.yaml \
  --wait --timeout 3m

log "Applying Grafana dashboards and PrometheusRules"
kubectl apply -f charts/values/grafana-dashboard-users-service.yaml
kubectl apply -f charts/values/grafana-dashboard-slo.yaml
kubectl apply -f charts/values/slo-rules.yaml
kubectl apply -f charts/values/slo-rules-orders.yaml

# -------------------------------------------------------------------
# 9. ArgoCD
# -------------------------------------------------------------------
log "Installing ArgoCD (${ARGOCD_VERSION})"
kubectl apply -n argocd -f \
  "https://raw.githubusercontent.com/argoproj/argo-cd/${ARGOCD_VERSION}/manifests/install.yaml" >/dev/null

log "Waiting for ArgoCD server to be ready"
kubectl wait --for=condition=available \
  deployment/argocd-server -n argocd --timeout=5m

log "Applying ArgoCD Application CRDs"
kubectl apply -f argocd/

# -------------------------------------------------------------------
# Done
# -------------------------------------------------------------------
cat <<'EOF'

────────────────────────────────────────────────────────────────
  ObservaShop is up.

  Port-forwards to access UIs (run each in its own terminal):

    Grafana:     kubectl port-forward -n monitoring svc/kps-grafana 3000:80
                 → http://localhost:3000   (admin / prom-operator)

    Prometheus:  kubectl port-forward -n monitoring \
                   svc/kps-kube-prometheus-stack-prometheus 9090
                 → http://localhost:9090

    ArgoCD:      kubectl port-forward -n argocd svc/argocd-server 8080:80
                 → http://localhost:8080   (user: admin)
                 password:
                   kubectl -n argocd get secret argocd-initial-admin-secret \
                     -o jsonpath='{.data.password}' | base64 -d

  Verify the cluster is healthy:
    kubectl get pods -A
    kubectl get applications -n argocd

  Tear down when done:
    kind delete cluster --name observashop
    docker rm -f kind-registry
────────────────────────────────────────────────────────────────
EOF
