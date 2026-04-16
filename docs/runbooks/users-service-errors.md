# Runbook: users-service error budget burn

**Alerts covered:** `UsersServiceErrorBudgetFastBurn`, `UsersServiceErrorBudgetSlowBurn`
**Severity:** critical (fast burn) / warning (slow burn)
**SLO:** users_service_availability — 99.9% over 30 days

## What this means

The fraction of HTTP requests to users-service returning 5xx is high enough that the 30-day error budget will be exhausted before the window closes if the trend continues.

| Burn rate | Budget exhausted in | Action |
| --- | --- | --- |
| 14.4× (fast) | ~2 hours | Page on-call immediately |
| 6× (slow) | ~5 hours | Open ticket, investigate within the hour |

Both alerts use the multi-window pattern: a short window (5m / 30m) confirms the burn is happening **right now**, a long window (1h / 6h) prevents flapping on transient spikes. Both conditions must be true for the alert to fire.

## Immediate triage (first 5 minutes)

### Step 1 — Confirm the alert is real

Run in your terminal to check if pods are healthy:

```
kubectl get pods -n observashop -l app.kubernetes.io/name=users-service
kubectl top pods -n observashop -l app.kubernetes.io/name=users-service
```

If pods show `CrashLoopBackOff` or `Error`, skip to **Diagnostic paths → Pod crashes** below. If all pods show `Running`, continue to Step 2.

### Step 2 — Check whether chaos injection is active

This is the most common cause in dev environments. Run in your terminal:

```
kubectl exec -n observashop deploy/users-service -- wget -qO- http://localhost:3000/chaos/status
```

This hits the chaos endpoint inside users-service and prints the current injected error rate. If the output shows a non-zero error rate (e.g. `{"errorRate":1}`), that means someone left fault injection on. Disable it by running in your terminal:

```
kubectl exec -n observashop deploy/users-service -- wget -qO- 'http://localhost:3000/chaos/error-rate?rate=0' --post-data=''
```

Or if the Go CLI is available:

```
observashop-cli chaos error-rate --rate 0
```

After disabling, wait 5 minutes and check Prometheus to see if the error rate drops. If it does, the alert will auto-resolve. You're done — skip to **Post-incident**.

### Step 3 — Check the live error rate

Open Grafana in your browser (port-forward first if not already running):

```
kubectl port-forward -n monitoring svc/kps-grafana 3000:80
```

Then open `http://localhost:3000` → navigate to the **"ObservaShop - Users Service"** dashboard → look at the **Error Rate** panel. If the panel shows elevated errors, note the timestamp when the spike started.

To get the exact number, open Prometheus (`http://localhost:9090`) → click the **Graph** tab → paste this query and click **Execute**:

```
sum(rate(http_requests_total{service="users-service",status=~"5.."}[5m]))
  / sum(rate(http_requests_total{service="users-service"}[5m]))
```

A result above `0.0144` (i.e. 1.44%) means the fast-burn threshold is breached. Above `0.006` (0.6%) means the slow-burn threshold is breached.

### Step 4 — Pull recent logs

Open Grafana → go to the **Explore** page → select the **Loki** datasource → run this LogQL query:

```
{namespace="observashop", app="users-service"} |= "error" | json
```

Look for patterns: repeated stack traces, database connection errors, timeout messages.

## Diagnostic paths

### Recent deploy caused the errors

Check what ArgoCD last synced. Run in your terminal:

```
kubectl get application users-service -n argocd -o jsonpath='{.status.history[-1]}'
```

If the most recent sync timestamp lines up with when errors started, the new code is likely the cause. Fix by reverting the bad commit in Git and pushing to main — ArgoCD auto-syncs within 3 minutes.

### Database is down or degraded

The readiness probe checks the DB, so if Postgres is fully down, pods go `NotReady` and traffic routes away. But partial failures (slow queries, connection pool exhaustion) still cause 5xx. Check Postgres health in your terminal:

```
kubectl get pods -n observashop postgres-postgresql-0
kubectl logs -n observashop postgres-postgresql-0 --tail=100
```

Common causes: PVC is full (check with `kubectl exec ... -- df -h`), too many connections, or a schema migration failed on startup.

### Pod crashes

If pods are in `CrashLoopBackOff`, check the logs of the most recent crash:

```
kubectl logs -n observashop -l app.kubernetes.io/name=users-service --previous --tail=100
```

Common causes: OOM killed (check `kubectl describe pod <pod-name>` for `OOMKilled` in the last state), unhandled exception in application code, or missing environment variable / secret.

### Steady error rate with no obvious cause

users-service has no upstream service dependencies (unlike orders-service), so if the DB is healthy and no deploy happened, investigate at the node level:

```
kubectl get nodes
kubectl describe node <node-name-running-users-service-pods>
```

Look for `DiskPressure`, `MemoryPressure`, or `NotReady` conditions.

## Mitigation summary

| Cause | Fix |
| --- | --- |
| Chaos injection left on | `observashop-cli chaos error-rate --rate 0` |
| Bad deploy | `git revert <commit>` and push; ArgoCD auto-syncs |
| DB connection storm | Scale users-service to 1 replica (`kubectl scale deploy/users-service -n observashop --replicas=1`), wait for connections to drain, scale back up |
| OOM / CPU throttling | Bump resource limits in `charts/values/users-service.yaml`, push to Git |
| Node-level failure | Cordon the bad node (`kubectl cordon <node>`), pods reschedule to healthy nodes |

## Escalation

If error rate stays above 1% for 15 minutes after working through the steps above, escalate:

1. Snapshot the current Prometheus state (run in terminal):
   ```
   curl -s 'http://localhost:9090/api/v1/query?query=sli:users_service:error_ratio:rate5m'
   ```
2. Capture pod logs to a file (run in terminal):
   ```
   kubectl logs -n observashop -l app.kubernetes.io/name=users-service --tail=500 > /tmp/users-incident-$(date +%s).log
   ```
3. Page the platform owner. In a real org this routes through PagerDuty; for ObservaShop this is a single-maintainer project.

## Post-incident

- If the incident lasted >15 minutes or burned >10% of the monthly error budget, write a postmortem in `docs/postmortem.md`.
- If the cause was a code defect, file a ticket to add a regression test.
- Review whether the 14.4× / 6× burn-rate thresholds caught the issue early enough. Tune if needed.
