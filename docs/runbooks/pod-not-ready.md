# Runbook: service pod not ready

**Alerts covered:** `UsersServicePodNotReady`, `OrdersServicePodNotReady`
**Severity:** critical
**SLO:** users_service_availability / orders_service_availability

## What this means

Fewer than 2 healthy pods are running for the affected service. The alert expression checks `sum(up{namespace="observashop", pod=~"<service>.*"}) < 2` over a 2-minute window.

With the default `replicaCount: 2`, this means at least one pod has failed its readiness probe, crashed, or been evicted. If both pods are down, the service is fully unavailable.

## Immediate triage (first 5 minutes)

### Step 1 — Check pod status

Run in your terminal (replace `<service-name>` with `users-service` or `orders-service`):

```
kubectl get pods -n observashop -l app.kubernetes.io/name=<service-name>
```

Note the STATUS column. Common states and what they mean:

| Status | Meaning | Go to |
| --- | --- | --- |
| `Running` but `0/1 READY` | Readiness probe failing | Step 2 |
| `CrashLoopBackOff` | Container crashing on startup | Step 3 |
| `ImagePullBackOff` | Cannot pull the container image | Step 4 |
| `Pending` | Cannot be scheduled (no node capacity) | Step 5 |
| `Terminating` (stuck) | Node or kubelet issue | Step 6 |

### Step 2 — Readiness probe failing

The readiness probe hits `/readyz`, which checks the database connection. If the probe fails, Kubernetes removes the pod from the Service — it stops getting traffic but keeps running. Run:

```
kubectl describe pod <pod-name> -n observashop
```

Scroll to the **Events** section and look for `Unhealthy` events with `Readiness probe failed`. Then check if Postgres is reachable:

```
kubectl get pods -n observashop postgres-postgresql-0
kubectl exec -n observashop deploy/<service-name> -- wget -qO- http://localhost:3000/readyz
```

If `/readyz` returns an error about the database, fix Postgres first (see the [error budget runbook](users-service-errors.md) → Database section).

**Important:** The liveness probe (`/healthz`) does NOT check the database — this is by design (constraint #5 in CLAUDE_CONTEXT.md). A pod with a failing readiness probe stays alive but stops receiving traffic, which is the correct behavior.

### Step 3 — CrashLoopBackOff

The container is starting and immediately crashing. Get the logs from the last crash:

```
kubectl logs -n observashop <pod-name> --previous --tail=100
```

Common causes:
- **OOMKilled:** check `kubectl describe pod <pod-name>` → Last State → Reason. Bump memory limits in `charts/values/<service>.yaml`, push to Git.
- **Missing environment variable or secret:** the pod needs `DB_HOST`, `DB_USER`, etc. from the `postgres-postgresql` secret. Check if the secret exists: `kubectl get secret postgres-postgresql -n observashop`.
- **Schema migration failed:** users-service runs migrations on startup with retry-until-ready. If Postgres was genuinely down during all retries, the process exits.

### Step 4 — ImagePullBackOff

The container image can't be pulled. Run:

```
kubectl describe pod <pod-name> -n observashop
```

Look at the Events section for the exact error. Common causes:
- **Local registry down:** check `docker ps | grep kind-registry`. If missing, run `docker start kind-registry`.
- **Wrong image tag:** check the values file — the image tag should match what was pushed to `localhost:5001`.
- **kind network issue:** the registry must be on the same Docker network as kind nodes. Verify with `docker network inspect kind | grep kind-registry`.

### Step 5 — Pending (unschedulable)

The pod can't find a node with enough resources. Check:

```
kubectl describe pod <pod-name> -n observashop
```

Events will show `FailedScheduling` with a reason (Insufficient cpu, Insufficient memory, or node affinity mismatch). Fix by freeing resources on nodes or bumping down the pod's resource requests in the values file.

### Step 6 — Stuck Terminating

The pod won't die. Usually a kubelet or node issue. Force-delete:

```
kubectl delete pod <pod-name> -n observashop --grace-period=0 --force
```

The ReplicaSet will create a new pod automatically.

## Mitigation summary

| Cause | Fix |
| --- | --- |
| Postgres down | Fix Postgres; readiness probes will pass and pods rejoin the Service |
| OOMKilled | Bump memory limits in `charts/values/<service>.yaml`, push to Git |
| Missing secret | Recreate the `postgres-postgresql` secret (see Helm install commands in CLAUDE_CONTEXT.md) |
| Image pull failure | Restart local registry: `docker start kind-registry` |
| Node resource exhaustion | Scale down non-essential workloads or add a kind worker node |
| Stuck terminating pod | `kubectl delete pod <name> -n observashop --grace-period=0 --force` |

## Scaling behavior

With `replicaCount: 2`, losing one pod means 50% capacity loss. The remaining pod handles all traffic. If it also fails, the service is fully down and the error budget alert will fire simultaneously.

To temporarily increase resilience:

```
kubectl scale deploy/<service-name> -n observashop --replicas=3
```

This is a manual override — ArgoCD will revert it within 3 minutes (auto-sync + self-heal). For a persistent change, update `replicaCount` in the values file and push to Git.

## Post-incident

- If the service was fully unavailable (0 ready pods), write a postmortem.
- If the cause was resource exhaustion, review whether resource requests/limits are appropriate.
- If the cause was Postgres, consider whether the readiness probe timeout or failure threshold needs tuning.
