# Postmortem: users-service error budget exhaustion (chaos test)

**Date:** 2026-04-10
**Author:** Ayush Gupta
**Severity:** SEV-2 (simulated — deliberate fault injection in dev)
**Duration:** ~22 minutes (06:30 IST – 06:52 IST)
**Impact:** users-service availability dropped to ~0%, burning the 30-day error budget at 187× the sustainable rate. `UsersServiceErrorBudgetFastBurn` fired within 6 minutes. Secondary alert `UsersServicePodNotReady` fired after manual replica scale-down.

---

## Summary

On the morning of April 10, 2026, a deliberate chaos test was conducted on the ObservaShop kind cluster to validate the multi-window multi-burn-rate SLO alerting pipeline. A 100% error rate was injected into users-service via its `/chaos/error-rate` endpoint. The goal was to verify the full chain: fault injection → SLI recording rules recompute → burn-rate thresholds breach → alert transitions from Inactive → Pending → Firing.

The test succeeded. The alerting pipeline detected and escalated the fault within the expected timeframe. A secondary test — scaling users-service to 1 replica — validated the `UsersServicePodNotReady` health alert. Both alerts were confirmed Firing in the Prometheus UI and documented with screenshots.

This was not a production incident. It was a controlled validation of the observability and alerting stack. This postmortem documents it in incident format because the exercise proved the system works — and because the timeline, root cause analysis, and lessons learned are the same artifacts an SRE team would produce after a real outage.

---

## Timeline (all times IST, April 10, 2026)

| Time | Event |
| --- | --- |
| 04:57 | Grafana operational dashboard for users-service finalized and screenshotted. Baseline: all panels healthy, 0% error rate, p99 latency nominal. |
| 06:14 | SLO dashboard with availability, latency, and error-budget burn-rate panels finalized. Baseline screenshot captured showing 100% availability, 0× burn rate. |
| ~06:30 | **Fault injected.** `curl` to users-service `/chaos/error-rate?rate=1` set the error rate to 100%. Every subsequent request to users-service returned HTTP 500. |
| 06:34 | Grafana availability panel showed the drop. SLO dashboard confirmed: availability plummeting, burn rate climbing. Screenshot captured ("Grafana Availability Drop"). |
| 06:36 | `UsersServiceErrorBudgetFastBurn` transitioned **Inactive → Pending**. Prometheus evaluated the 5m and 1h recording rules; both exceeded the 14.4× burn-rate threshold (14.4 × 0.001 = 0.0144). The `for: 2m` hold-off started. Screenshot captured ("Prometheus Pending State"). |
| 06:42 | `UsersServiceErrorBudgetFastBurn` transitioned **Pending → Firing**. The 2-minute hold-off elapsed with the condition still true. Alert now visible in the Firing tab of the Prometheus Alerts UI. Screenshot captured ("Prometheus Firing State - UsersServiceErr"). |
| ~06:45 | **Error injection disabled.** `curl` to `/chaos/error-rate?rate=0` restored normal operation. Error rate returned to 0% within one scrape interval (~30s). |
| ~06:47 | **Replica scale-down.** `kubectl scale deployment users-service --replicas=1` reduced healthy pods below the threshold of 2. This tested the `UsersServicePodNotReady` alert independently of the error-budget alerts. |
| 06:52 | `UsersServicePodNotReady` transitioned **Inactive → Pending → Firing**. The `sum(up{...}) < 2` expression evaluated true for the `for: 2m` hold-off. Screenshot captured ("Prometheus Firing State - PodNotReady"). |
| ~06:55 | **Replicas restored.** `kubectl scale deployment users-service --replicas=2`. Both alerts resolved within the next evaluation cycle. |

**Total time from injection to first Firing alert: ~12 minutes** (6 min for the recording rules to accumulate enough data + 2 min `for` hold-off + evaluation interval jitter).

---

## Root cause

Not applicable in the traditional sense — the fault was deliberately injected. The "root cause" was a `curl` command setting `/chaos/error-rate?rate=1` on users-service, which causes the Express middleware to return HTTP 500 for 100% of incoming requests.

The chaos endpoint is a runtime fault-injection mechanism built into users-service for exactly this purpose. It mirrors how Envoy/Istio fault injection works in production service meshes — a configuration change at the proxy/middleware layer, not a code defect.

---

## Detection

| Signal | Worked? | Time to detect |
| --- | --- | --- |
| Grafana availability panel | Yes | ~4 min (visible at 06:34, injected at ~06:30) |
| SLI recording rules (`sli:users_service:error_ratio:rate5m`) | Yes | Recomputed within the 30s evaluation interval |
| `UsersServiceErrorBudgetFastBurn` alert | Yes | ~12 min injection-to-Firing (includes 2m hold-off) |
| `UsersServicePodNotReady` alert | Yes | ~5 min scale-down-to-Firing |

All four detection layers triggered correctly and in the expected order:

1. **Grafana dashboards** (human-visible, fastest — depends on refresh interval)
2. **Recording rules** (machine-computed SLIs, sub-minute)
3. **Burn-rate alerts** (multi-window gating prevents flapping, intentionally slower)
4. **Health alerts** (direct pod-count check, independent of SLO framework)

---

## What went well

- **The multi-window pattern worked exactly as designed.** The short window (5m) caught the spike immediately; the long window (1h) confirmed it wasn't transient; the `for: 2m` hold-off prevented flapping. The alert didn't fire on noise — it fired on a real, sustained fault.
- **Recording rules decoupled SLIs from alerts.** Alert expressions reference pre-computed `sli:users_service:error_ratio:rate5m` instead of raw histograms. This kept the alert rules clean and debuggable — you could query the SLI directly in Prometheus to see the exact value the alert was evaluating.
- **Dashboards provided immediate visual confirmation.** Before the alert even transitioned to Pending, the Grafana panels showed the availability drop and burn-rate spike. In a real incident, the on-call would see the dashboard and start investigating before the page arrives.
- **Two independent alert types caught two independent failure modes.** Error-budget alerts (burn rate) and health alerts (pod count) are separate concerns. Scaling down replicas didn't trigger the error-budget alert; injecting errors didn't trigger the pod-not-ready alert. Each alert fires for exactly the failure it's designed to detect.
- **The chaos endpoint made injection trivial.** No need for external tools, CRDs, or sidecar proxies. A single `curl` toggled the fault on and off. This is the same pattern Envoy uses — runtime config, not code changes.

## What went poorly

- **No automated rollback or notification.** The alert fired, but nothing happened downstream. In production, `UsersServiceErrorBudgetFastBurn` at `severity: critical` should page an on-call engineer via PagerDuty/Opsgenie and optionally trigger an automated rollback. In ObservaShop, the alert fires into the void — Alertmanager has no receivers configured beyond the default.
- **The 1h long window had no data at the start.** When the cluster is freshly deployed, the 1h recording rule (`sli:users_service:error_ratio:rate1h`) has no historical data. It immediately reflects the current error rate rather than dampening it over a real 1-hour window. This means the multi-window gating is less effective in the first hour of cluster life — both windows see the same spike, so the long window doesn't add the "is this sustained?" signal it's supposed to. In a long-running production system this isn't an issue, but it's worth knowing for test environments.
- **No runbooks linked at the time.** The `UsersServiceErrorBudgetFastBurn` alert had a `Runbook` annotation pointing at `docs/runbooks/users-service-errors.md`, but that file didn't exist during the test. The link was a dead end. (Fixed as part of Day 10 — runbooks now exist.)
- **Chaos injection has no access control.** The `/chaos/error-rate` endpoint is unauthenticated and available to anyone who can reach the pod. In a shared cluster, this is a risk — any developer could accidentally (or deliberately) inject faults. Production systems use feature flags with RBAC or dedicated chaos platforms (LitmusChaos, Chaos Mesh) that require explicit permissions.

## Action items

| Action | Priority | Status |
| --- | --- | --- |
| Create runbooks for all alerts so annotation links resolve | P1 | **Done** (Day 10) |
| Add `runbook_url` annotations to alerts that are missing them | P1 | **Done** (Day 10) |
| Configure Alertmanager receivers (at minimum a webhook or Slack sink) | P2 | Backlog |
| Add RBAC or feature-flag gating to chaos endpoints | P3 | Backlog — acceptable risk in a single-developer dev cluster |
| Document the "cold start" limitation of long-window recording rules | P3 | **Done** (this postmortem) |
| Evaluate LitmusChaos or Chaos Mesh for structured chaos experiments with scheduling and rollback | P3 | Backlog — would be relevant for a team environment |

---

## Lessons learned from Day 9 GKE deployment

The Day 4 chaos test validated the alerting pipeline on a local kind cluster. Day 9 deployed the full ObservaShop stack to a real GKE cluster on GCP, which surfaced a different class of operational issues — infrastructure-level problems that don't appear in local development.

### GKE bootstrap default-pool disk quota

**What happened:** `terraform apply` failed on the first attempt with `Quota 'SSD_TOTAL_GB' exceeded`. GKE creates a temporary "default" node pool to bootstrap the cluster even when `remove_default_node_pool = true` is set. That bootstrap pool defaults to 100 GB pd-balanced (SSD) disks per node × 3 zones = 300 GB. The GCP free-trial account has a non-adjustable 250 GB SSD quota in `us-central1`.

**Fix:** Added a top-level `node_config { disk_size_gb = 20, disk_type = "pd-standard" }` block on the `google_container_cluster` resource to override the bootstrap pool's disk configuration. The bootstrap pool still gets created and destroyed, but with cheap pd-standard disks that don't hit the SSD quota.

**Lesson:** Terraform's declared state and GKE's runtime behavior diverge during cluster creation. The bootstrap pool is an implementation detail that leaks through when quotas are tight.

### Bitnami OCI credential helper failure

**What happened:** `helm install postgres oci://registry-1.docker.io/bitnamicharts/postgresql` triggered Docker Desktop's Windows credential helper (`docker-credential-desktop.exe`) from inside WSL. Result: `exec format error` — a Windows binary can't execute in Linux. The Bitnami OCI registry is public and needs no authentication, but Helm's OCI client still invokes the credential chain.

**Fix:** `DOCKER_CONFIG=/tmp/empty-docker-config helm install ...` — pointed Helm at an empty config directory to skip the broken credential helper entirely.

**Lesson:** WSL + Docker Desktop creates a hybrid environment where Linux tools can accidentally invoke Windows binaries through Docker's config chain. Any Helm chart that has migrated to OCI distribution will hit this.

### Insufficient node capacity for the full stack

**What happened:** 3× e2-medium nodes (≈3 vCPU usable total) couldn't schedule kube-prometheus-stack + Loki + Promtail + Postgres + 3 application services. Pods were stuck in Pending with `Insufficient cpu` / `Insufficient memory`.

**Fix:** Resized the node pool to 6 nodes (2 per zone × 3 zones) using `gcloud container clusters resize`. This gave enough headroom for the full stack.

**Lesson:** Observability infrastructure is expensive. kube-prometheus-stack alone (Prometheus, Alertmanager, Grafana, node-exporter, kube-state-metrics) consumes more resources than the application services it monitors. Capacity planning must account for the monitoring layer, not just the workload.

### GCP zonal capacity churn

**What happened:** One node in the regional cluster entered a repair loop — `compute.instances.repair.recreateInstance` operations every ~10 minutes, with "instance should be RUNNING, but it doesn't exist" in the operations log. GKE kept trying to recreate the VM in a zone with insufficient e2-medium capacity.

**Impact:** Cosmetic. The cluster remained usable (other zones were healthy), but pods on the affected node were evicted and rescheduled repeatedly. The demo video was recorded during an active repair cycle.

**Lesson:** Regional GKE on small machine types is subject to zonal capacity churn on GCP. No clean fix on the free tier — the tradeoff is HA (regional) vs. stability (zonal, pinned to one zone). For a portfolio project on trial credit, accepting the churn and documenting it is the right call.

---

*This postmortem was written on Day 10 of the ObservaShop project as a portfolio artifact demonstrating incident documentation practices.*
