# Runbook: orders-service error budget burn

**Alerts covered:** `OrdersServiceErrorBudgetFastBurn`, `OrdersServiceErrorBudgetSlowBurn`
**Severity:** critical (fast burn) / warning (slow burn)
**SLO:** orders_service_availability — 99.9% over 30 days

## What this means

The fraction of HTTP requests to orders-service returning 5xx is high enough that the 30-day error budget will be exhausted before the window closes if the trend continues.

| Burn rate | Budget exhausted in | Action |
| --- | --- | --- |
| 14.4× (fast) | ~2 hours | Page on-call immediately |
| 6× (slow) | ~5 hours | Open ticket, investigate within the hour |

Both alerts use the multi-window pattern: a short window (5m / 30m) confirms the burn is happening **right now**, a long window (1h / 6h) prevents flapping on transient spikes. Both conditions must be true for the alert to fire.

**Key difference from users-service:** orders-service fans out to both users-service and products-service over HTTP. If either upstream is failing, orders-service errors will rise even if its own code is healthy. Always check the `OrdersServiceUpstreamDegraded` alert first — see the [upstream-degraded runbook](upstream-degraded.md).

## Immediate triage (first 5 minutes)

### Step 1 — Confirm the alert is real

Run in your terminal to check if pods are healthy:

```
kubectl get pods -n observashop -l app.kubernetes.io/name=orders-service
kubectl top pods -n observashop -l app.kubernetes.io/name=orders-service
```

If pods show `CrashLoopBackOff` or `Error`, skip to **Diagnostic paths → Pod crashes** below. If all pods show `Running`, continue to Step 2.

### Step 2 — Check if the problem is upstream, not orders-service itself

Run in your terminal:

```
kubectl exec -n observashop deploy/orders-service -- wget -qO- http://users-service.observashop.svc:3000/healthz
kubectl exec -n observashop deploy/orders-service -- wget -qO- http://products-service.observashop.svc:3000/healthz
```

If either upstream returns an error or times out, the root cause is likely there, not in orders-service. Check the [users-service-errors runbook](users-service-errors.md) or the [upstream-degraded runbook](upstream-degraded.md).

### Step 3 — Check whether chaos injection is active on users-service

orders-service itself has no chaos endpoint, but users-service does. If someone injected errors on users-service, orders-service will fail on every request that calls users-service. Run in your terminal:

```
kubectl exec -n observashop deploy/users-service -- wget -qO- http://localhost:3000/chaos/status
```

If error-rate injection is non-zero, disable it:

```
observashop-cli chaos error-rate --rate 0
```

Wait 5 minutes and check if orders-service error rate drops. If it does, you're done — skip to **Post-incident**.

### Step 4 — Check the live error rate

Open Grafana in your browser (port-forward first if not already running):

```
kubectl port-forward -n monitoring svc/kps-grafana 3000:80
```

Open `http://localhost:3000` → navigate to the **"ObservaShop - SLO Dashboard"** → look at the orders-service panels.

To get the exact number, open Prometheus (`http://localhost:9090`) → click the **Graph** tab → paste this query and click **Execute**:

```
sum(rate(http_requests_total{service="orders-service",status=~"5.."}[5m]))
  / sum(rate(http_requests_total{service="orders-service"}[5m]))
```

A result above `0.0144` (1.44%) means the fast-burn threshold is breached.

### Step 5 — Pull recent logs

Open Grafana → **Explore** page → select the **Loki** datasource → run this LogQL query:

```
{namespace="observashop", app="orders-service"} |= "error" | json
```

Look for: upstream timeout messages (5-second `AbortSignal.timeout`), database errors, or unhandled exceptions.

## Diagnostic paths

### Upstream dependency failure

If users-service or products-service is unhealthy, orders-service errors are a symptom, not the root cause. Follow the [users-service-errors runbook](users-service-errors.md) or [upstream-degraded runbook](upstream-degraded.md) first. Once upstreams recover, orders-service errors should clear within 5 minutes.

### Recent deploy caused the errors

Check what ArgoCD last synced. Run in your terminal:

```
kubectl get application orders-service -n argocd -o jsonpath='{.status.history[-1]}'
```

If the timestamp matches the start of errors, revert the bad commit in Git and push to main — ArgoCD auto-syncs within 3 minutes.

### Database is down or degraded

orders-service uses the `orders` database on the same Postgres instance. Check Postgres health:

```
kubectl get pods -n observashop postgres-postgresql-0
kubectl logs -n observashop postgres-postgresql-0 --tail=100
```

Verify the `orders` database is accessible:

```
kubectl exec -n observashop postgres-postgresql-0 -- bash -c \
  'PGPASSWORD=observashop-dev-pw psql -U observashop -d orders -c "SELECT 1;"'
```

### Pod crashes

If pods are in `CrashLoopBackOff`:

```
kubectl logs -n observashop -l app.kubernetes.io/name=orders-service --previous --tail=100
```

Check `kubectl describe pod <pod-name>` for `OOMKilled` in the last state.

## Mitigation summary

| Cause | Fix |
| --- | --- |
| Upstream failure (users/products-service down) | Fix the upstream first; orders-service recovers automatically |
| Chaos injection on users-service | `observashop-cli chaos error-rate --rate 0` |
| Bad deploy | `git revert <commit>` and push; ArgoCD auto-syncs |
| DB issue | Check Postgres logs and connectivity; restart if needed |
| OOM / CPU throttling | Bump resource limits in `charts/values/orders-service.yaml`, push to Git |

## Escalation

If error rate stays above 1% for 15 minutes after working through the steps above:

1. Snapshot Prometheus state (run in terminal):
   ```
   curl -s 'http://localhost:9090/api/v1/query?query=sli:orders_service:error_ratio:rate5m'
   ```
2. Capture pod logs to a file (run in terminal):
   ```
   kubectl logs -n observashop -l app.kubernetes.io/name=orders-service --tail=500 > /tmp/orders-incident-$(date +%s).log
   ```
3. Page the platform owner.

## Post-incident

- If the incident lasted >15 minutes or burned >10% of the monthly error budget, write a postmortem in `docs/postmortem.md`.
- If the cause was an upstream failure, consider whether `OrdersServiceUpstreamDegraded` fired early enough as a warning.
- Review the 5-second `AbortSignal.timeout` — if upstream latency is legitimately higher, the timeout may need tuning.
