#!/usr/bin/env bash
# Creates a local Docker registry and wires it into the kind cluster.
# Idempotent — safe to run multiple times.
set -euo pipefail

REG_NAME='kind-registry'
REG_PORT='5001'
CLUSTER_NAME='observashop'

# 1. Start the registry if not already running
if [ "$(docker inspect -f '{{.State.Running}}' "${REG_NAME}" 2>/dev/null || true)" != 'true' ]; then
  docker run -d --restart=always -p "127.0.0.1:${REG_PORT}:5000" --name "${REG_NAME}" registry:2
fi

# 2. Connect registry to the kind network
if ! docker network inspect kind | grep -q "${REG_NAME}"; then
  docker network connect kind "${REG_NAME}"
fi

# 3. Configure every kind node to use the registry
REGISTRY_DIR="/etc/containerd/certs.d/localhost:${REG_PORT}"
for node in $(kind get nodes --name "${CLUSTER_NAME}"); do
  docker exec "${node}" mkdir -p "${REGISTRY_DIR}"
  cat <<REGCONF | docker exec -i "${node}" tee "${REGISTRY_DIR}/hosts.toml" > /dev/null
[host."http://${REG_NAME}:5000"]
REGCONF
done

# 4. Document the registry location for the cluster
cat <<YAML | kubectl apply -f -
apiVersion: v1
kind: ConfigMap
metadata:
  name: local-registry-hosting
  namespace: kube-public
data:
  localRegistryHosting.v1: |
    host: "localhost:${REG_PORT}"
    help: "https://kind.sigs.k8s.io/docs/user/local-registry/"
YAML

echo "Local registry running at localhost:${REG_PORT}"
