# Runbook: orders-service upstream degraded

**Alert covered:** `OrdersServiceUpstreamDegraded`
**Severity:** warning
**SLO:** orders_service_dependencies

## What this means

More than 5% of orders-service's outbound HTTP requests to an upstream dependency (users-service or products-service) are failing. The alert expression:

```
sli:orders_service:upstream_error_ratio:rate5m > 0.05
```

This fires after 5 minutes of sustained upstream errors. It is an **early-warning signal** — it fires before orders-service's own error budget starts burning, giving you time to fix the dependency before customer-facing impact escalates.

The alert label `{{ $labels.target_service }}` tells you which upstream is failing.

## Immediate triage (first 5 minutes)

### Step 1 — Identify which upstream is failing

Open Prometheus (`http://localhost:9090`) → **Graph** tab → paste and click **Execute**:

```
sli:orders_service:upstream_error_ratio:rate5m
```

The result will have a `target_service` label showing either `users-service` or `products-service` (or both).

### Step 2 — Check the failing upstream directly

Run in your terminal (replace `<target-service>` with the failing upstream):

```
kubectl get pods -n observashop -l app.kubernetes.io/name=<target-service>
kubectl exec -n observashop deploy/orders-service -- wget -qO- http://<target-service>.observashop.svc:3000/healthz
```

If the health check fails or pods are unhealthy, the problem is in the upstream — follow the appropriate runbook:
- users-service down → [users-service-errors runbook](users-service-errors.md)
- products-service down → check pods and logs (products-service is in-memory with no DB, so failures are rare)

### Step 3 — Check if chaos injection is active on users-service

users-service has chaos endpoints that can cause it to return errors. Run:

```
kubectl exec -n observashop deploy/users-service -- wget -qO- http://localhost:3000/chaos/error-rate
```

If error-rate or latency injection is active, disable it:

```
observashop-cli chaos error-rate --rate 0
observashop-cli chaos latency --ms 0
```

### Step 4 — Check for network-level issues

If pods are healthy but HTTP calls between services fail, it could be a DNS or networking issue inside the cluster. Test DNS resolution from inside orders-service:

```
kubectl exec -n observashop deploy/orders-service -- nslookup users-service.observashop.svc.cluster.local
```

If DNS fails, check CoreDNS pods:

```
kubectl get pods -n kube-system -l k8s-app=kube-dns
kubectl logs -n kube-system -l k8s-app=kube-dns --tail=50
```

### Step 5 — Check for timeout-related failures

orders-service uses a 5-second `AbortSignal.timeout` on all upstream HTTP calls. If an upstream is slow but not down, requests may be timing out and registering as errors. Check upstream latency:

```
histogram_quantile(0.99, sum(rate(http_client_request_duration_seconds_bucket{service="orders-service"}[5m])) by (le, target_service))
```

Run this in Prometheus. If p99 is close to 5 seconds, the timeout is triggering. Fix the upstream latency first — see the [latency runbook](latency-slo-burn.md).

## Why this alert matters

The dependency alert pattern is deliberately separate from the error-budget alerts. Here's the sequence when an upstream fails:

1. **First (within 5 min):** `OrdersServiceUpstreamDegraded` fires — you know the dependency is failing.
2. **Next (within 7-10 min):** `OrdersServiceErrorBudgetFastBurn` fires — orders-service's own error budget is now burning because upstream errors propagate as 5xx responses.
3. **Eventually:** orders-service exhausts its error budget.

The upstream alert gives you a head start. If you fix the dependency during step 1, you may prevent step 2 entirely.

## Mitigation summary

| Cause | Fix |
| --- | --- |
| Upstream service crashed | Fix the upstream (see its runbook); orders-service recovers automatically |
| Chaos injection on users-service | `observashop-cli chaos error-rate --rate 0` |
| Upstream slow (timeout triggers) | Fix upstream latency; see [latency runbook](latency-slo-burn.md) |
| DNS / networking failure | Check CoreDNS pods; restart if needed |
| Upstream recently deployed bad code | Revert the upstream's commit; ArgoCD auto-syncs |

## Escalation

If the upstream cannot be fixed within 15 minutes:

1. Check whether orders-service's own error budget alert has fired:
   ```
   curl -s 'http://localhost:9090/api/v1/query?query=ALERTS{alertname="OrdersServiceErrorBudgetFastBurn"}'
   ```
2. Capture cross-service logs (run in terminal):
   ```
   kubectl logs -n observashop -l app.kubernetes.io/part-of=observashop --tail=200 > /tmp/upstream-incident-$(date +%s).log
   ```
3. Page the platform owner.

## Post-incident

- Review whether the 5% threshold and 5-minute `for` duration caught the issue early enough.
- If the root cause was in users-service, ensure that service's own alerts also fired — if they didn't, the SLO rules may need tuning.
- Consider whether the 5-second timeout on upstream calls is appropriate for the workload.
