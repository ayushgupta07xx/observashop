# Runbook: latency SLO fast burn

**Alerts covered:** `UsersServiceLatencySLOFastBurn`, `OrdersServiceLatencySLOFastBurn`
**Severity:** critical
**SLO:** p99.9 latency < 250ms (users-service) / < 500ms (orders-service)

## What this means

Too many requests are exceeding the latency threshold. The alert fires when the fraction of "slow" requests is burning the latency error budget at 14.4× the sustainable rate across both the 5-minute and 1-hour windows.

| Service | Latency threshold | Why different |
| --- | --- | --- |
| users-service | 250ms | Direct DB queries only |
| orders-service | 500ms | Fans out to users-service and products-service over HTTP, so inherently slower |

## Immediate triage (first 5 minutes)

### Step 1 — Confirm the alert is real

Run in your terminal:

```
kubectl get pods -n observashop -l app.kubernetes.io/name=<service-name>
kubectl top pods -n observashop -l app.kubernetes.io/name=<service-name>
```

Replace `<service-name>` with `users-service` or `orders-service` depending on which alert fired. High CPU usage (close to the resource limit) is a strong signal for latency issues.

### Step 2 — Check whether chaos latency injection is active

Only users-service has chaos endpoints. Run in your terminal:

```
kubectl exec -n observashop deploy/users-service -- wget -qO- http://localhost:3000/chaos/status
```

If latency injection is active (e.g. `{"latency":2000}`), that's the cause. Disable it:

```
observashop-cli chaos latency --ms 0
```

Wait 5 minutes for the recording rules to recalculate. If the alert resolves, you're done — skip to **Post-incident**.

**Note:** If `UsersServiceLatencySLOFastBurn` fires, it will also cause `OrdersServiceLatencySLOFastBurn` because orders-service calls users-service. Fix users-service first.

### Step 3 — Check latency percentiles in Grafana

Port-forward Grafana if not already running:

```
kubectl port-forward -n monitoring svc/kps-grafana 3000:80
```

Open `http://localhost:3000` → **"ObservaShop - Users Service"** dashboard → look at the **Request Duration** panel. The p99 line should be below 250ms for users-service.

For the raw number, open Prometheus (`http://localhost:9090`) → **Graph** tab → paste and click **Execute**:

For users-service:
```
histogram_quantile(0.999, sum(rate(http_request_duration_seconds_bucket{service="users-service"}[5m])) by (le))
```

For orders-service:
```
histogram_quantile(0.999, sum(rate(http_request_duration_seconds_bucket{service="orders-service"}[5m])) by (le))
```

## Diagnostic paths

### Database slow queries (users-service and orders-service)

Both services query Postgres. Check DB query latency in Prometheus:

```
histogram_quantile(0.99, sum(rate(db_query_duration_seconds_bucket{service="users-service"}[5m])) by (le))
```

If this is high (>100ms), the DB is the bottleneck. Check Postgres:

```
kubectl logs -n observashop postgres-postgresql-0 --tail=100
```

Common causes: missing indexes, full PVC, high connection count, vacuum not running.

### Upstream latency (orders-service only)

orders-service calls users-service and products-service over HTTP with a 5-second timeout. Check upstream latency:

```
histogram_quantile(0.99, sum(rate(http_client_request_duration_seconds_bucket{service="orders-service"}[5m])) by (le, target_service))
```

If one upstream is slow, fix that service first. orders-service latency will recover once its dependencies are fast again.

### Resource throttling

If pods are hitting CPU limits, Kubernetes throttles them, causing latency spikes. Check:

```
kubectl describe pod <pod-name> -n observashop
```

Look at `resources.limits.cpu` vs actual usage from `kubectl top pods`. If throttled, bump CPU limits in the relevant values file under `charts/values/`, push to Git.

### Node-level resource pressure

```
kubectl top nodes
kubectl describe node <node-name>
```

Look for `MemoryPressure` or high CPU usage across the node. On kind clusters, all nodes share the host's resources — if your machine is under load, everything slows down.

## Mitigation summary

| Cause | Fix |
| --- | --- |
| Chaos latency injection | `observashop-cli chaos latency --ms 0` |
| DB slow queries | Check Postgres logs; consider adding indexes or increasing PVC |
| Upstream dependency slow (orders-service) | Fix the upstream service first |
| CPU throttling | Bump CPU limits in `charts/values/<service>.yaml`, push to Git |
| Node resource pressure | Close resource-heavy local processes; or add kind worker nodes |

## Escalation

If p99 latency stays above threshold for 15 minutes after triage:

1. Capture a Prometheus snapshot (run in terminal):
   ```
   curl -s 'http://localhost:9090/api/v1/query?query=sli:users_service:latency_bad_ratio:rate5m'
   ```
2. Capture pod logs:
   ```
   kubectl logs -n observashop -l app.kubernetes.io/name=<service-name> --tail=500 > /tmp/latency-incident-$(date +%s).log
   ```
3. Page the platform owner.

## Post-incident

- If the incident burned >10% of the latency error budget, write a postmortem.
- Review whether the 250ms / 500ms thresholds are still appropriate for the workload.
- If the cause was DB-related, file a ticket to add query performance monitoring or slow-query logging.
