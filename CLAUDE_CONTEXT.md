# ObservaShop — Project Brief

**Read this doc first. Don't make any assumptions outside of it. Ask me before deviating.**

---

## What the project is

ObservaShop is a production-grade microservice platform built on Kubernetes as a portfolio project for Ayush Gupta (CS undergrad, May 2026 graduate) to demonstrate end-to-end DevOps, SRE, and backend engineering skills for off-campus fresher job applications. The goal is a 90+ ATS score across DevOps and SRE resume targets. It is a single project across roughly 12 working days that builds a real observable, alerting, GitOps-driven, chaos-tested microservice platform — intentionally over-engineered for a fresher project because the over-engineering *is* the resume. Priority order of target roles: DevOps > SRE > SWE > AI/ML > Data Analyst. This project serves the first three; AI/ML is handled by separate existing projects (Crop Yield with CatBoost, ClipArt AI).

**Repo:** https://github.com/ayushgupta07xx/observashop

---

## Tech stack and key decisions already made

These are locked in. Do not re-litigate.

- **Host environment:** Windows 11 with WSL2 Ubuntu 22.04. All work happens inside WSL. Editor is VS Code with the WSL extension. Docker Desktop with WSL2 backend, disk image relocated to `E:\DockerDesktop` (was moved mid-project to free C drive space).
- **Kubernetes:** kind v0.23.0 running 3 nodes (1 control plane + 2 workers). Cluster name is `observashop`. Kubernetes v1.30. Why kind and not minikube/k3d: kind is what the Kubernetes project uses internally, supports multi-node easily, best containerd story.
- **Microservices:** Node.js 20 + TypeScript + Express 5. Why Node: already on Ayush's resume, small images, fast startup, the point of the project is the infra around the services not the services themselves. Go is added separately as a CLI tool (Day 7) for credible "I write Go" claim without rewriting working services.
- **Observability stack:** `kube-prometheus-stack` (Prometheus + Alertmanager + Grafana + node-exporter + kube-state-metrics, all via the community Helm chart). Loki via the modern `grafana/loki` v3 single-binary chart — NOT the deprecated `loki-stack` chart which ships Loki 2.6.1 that Grafana 12 can't health-check. Promtail DaemonSet for log shipping. Metrics use `prom-client`, logs use `pino`.
- **Packaging:** One reusable Helm chart (`charts/microservice/`) parameterized by per-service values files. All services use the same chart. Rationale: DRY, and real platform teams work this way.
- **GitOps:** ArgoCD manages Helm releases via `Application` CRDs with `automated.prune`, `automated.selfHeal`, and `ServerSideApply`. Git is the source of truth. No more `helm install` from laptop after Day 5.
- **CI/CD:** GitHub Actions with path-filtered matrix builds (one job per service, skips services that didn't change). Trivy scans gate on CRITICAL/HIGH CVEs. Accepted-risk CVEs live in per-service `.trivyignore` files with documented justifications (package, severity, reachability analysis, review date). Images pushed to GitHub Container Registry (`ghcr.io/ayushgupta07xx/observashop/<service>`) on main branch only, tagged with short commit SHA.
- **Image registries:** Two in play. Local `localhost:5001` via a `registry:2` container wired into the kind Docker network (for local dev — Helm values point here). `ghcr.io/ayushgupta07xx/observashop/<service>` for CI-built images, public, accessible to recruiters.
- **Database:** PostgreSQL 16 via Bitnami Helm chart. Single instance, two databases: `users` and `orders`. 1 GiB PVC. Credentials via Helm secret (`postgres-postgresql`), referenced by services through `secretKeyRef`.
- **SLOs:** Defined as PrometheusRule CRDs with recording rules over 5m/30m/1h/6h windows. Multi-window multi-burn-rate alerts following the Google SRE book pattern (burn rates 14.4x, 6x, 3x, 1x). Targets: 99.9% availability, p99 latency < 250ms (users-service) / < 500ms (orders-service, higher because it fans out to upstreams). Alerts fire Inactive -> Pending -> Firing as designed and were verified by deliberate chaos injection.
- **Chaos testing:** Runtime fault injection via in-service `/chaos/error-rate` and `/chaos/latency` endpoints on users-service. Pattern: real fault injection as Envoy/Istio do it, not a separate tool. LitmusChaos and Chaos Mesh are mentioned as "production-grade equivalents" for interview context only, not installed.
- **Go CLI (Day 7):** Built with `cobra` + `client-go`. Uses in-cluster config when running as a pod, falls back to `~/.kube/config` when local.

---

## Current state

### What's done (Days 1-7 complete as of this document)

1. **Day 1:** WSL2 Ubuntu, Docker Desktop, kubectl, kind, Helm, Terraform, Git, GitHub repo created with first commit.
2. **Day 2:** users-service written in TypeScript with `/healthz`, `/readyz`, `/metrics`, pg-less CRUD; multi-stage hardened Dockerfile; 3-node kind cluster running; deployed via raw manifests.
3. **Day 3:** products-service (second service); local Docker registry wired into kind; both services converted to use a single reusable `charts/microservice/` Helm chart with per-service values. Postgres installed via Bitnami chart, users-service rewritten to use it with connection pool, schema migration with retry-until-ready, readiness probe checks DB.
4. **Day 4 (the heaviest day):** Full observability stack. kube-prometheus-stack installed. Loki + Promtail (after migrating from deprecated loki-stack to modern grafana/loki). Custom "ObservaShop - Users Service" Grafana dashboard as a ConfigMap with request rate, error rate, latency percentiles, DB query latency, healthy pods, live log panel. PrometheusRule with SLI recording rules and multi-window burn-rate alerts. SLO dashboard with availability, latency, and error-budget burn rate stat panels. Chaos endpoint added to users-service. End-to-end verified: injected 100% error rate -> `UsersServiceErrorBudgetFastBurn` transitioned Inactive -> Pending -> Firing within ~5 minutes. Scaled replicas to 1 -> `UsersServicePodNotReady` fired within ~3 min. Screenshots of both Firing states saved.
5. **Day 5:** ArgoCD installed. users-service and products-service converted to ArgoCD Applications with auto-sync, self-heal, prune, and ServerSideApply. GitOps loop verified (changed `replicaCount` in Git -> cluster scaled automatically). GitHub Actions CI pipeline with matrix per service, Trivy scanning, GHCR publishing. Real CVE remediation story: Trivy caught node-tar, picomatch, zlib, and OpenSSL CVEs across multiple iterations. Fixed what could be fixed (base image bumps, npm `overrides` for picomatch), documented what couldn't with `.trivyignore` and reachability analysis. Final pipeline run was green; images visible at https://github.com/ayushgupta07xx?tab=packages.
6. **Day 6:** orders-service (third service) with inter-service HTTP calls to users-service and products-service. Instrumented with `http_client_request_duration_seconds` histogram. 5-second timeout via `AbortSignal.timeout`. New `OrdersServiceUpstreamDegraded` alert fires before the service's own error budget burns — early-warning dependency pattern. Wired into ArgoCD, CI matrix, and the SLO framework (`slo-rules-orders.yaml` PrometheusRule). Latency SLO is 500ms (higher than users-service's 250ms because orders fans out).
7. **Day 7 (current):** `observashop-cli` Go binary built with cobra + client-go. Four subcommands: `health` (pings /healthz on all services in parallel with latency reporting), `chaos` (wraps users-service chaos endpoints), `pods` (client-go List), `slo-status` (queries Prometheus /api/v1/alerts for alerts with an `slo` label). Auto-detects in-cluster vs local kubeconfig. Compiles to ~52 MB static Linux binary. Commands tested end-to-end against the live cluster.

### What's in progress

- Day 7 is partially done. Source code written, binary built, all four commands tested locally against the cluster (health, chaos, pods, slo-status all worked). Still to do for Day 7:
  - Write a multi-stage Dockerfile for the CLI (golang builder stage + distroless or scratch runtime)
  - Build and push the CLI image to GHCR via a small update to the GitHub Actions workflow
  - Commit everything with an atomic message
  - Optional: deploy it as a `kubectl run` one-shot pod to prove in-cluster mode works too

### What's next

| Day | Work | Notes |
|---|---|---|
| Finish Day 7 | Dockerfile + CI + commit for observashop-cli | ~30 minutes |
| Day 8 | Terraform modules for GKE (VPC, node pool, cluster). `terraform plan` only — no apply yet. Module layout: `terraform/modules/gke`, `terraform/modules/vpc`, `terraform/environments/dev`. | |
| Day 9 | Apply Terraform to real GKE (uses GCP $300 free credit), deploy ObservaShop via the same Helm charts, take screenshots, record a 2-minute demo video, then `terraform destroy`. Target cost: $0 within free tier. | |
| Day 10 | Postmortem doc (`docs/postmortem.md`) for the chaos test with timeline and root cause analysis. 3-5 runbooks in `docs/runbooks/` (referenced by alert annotations but don't exist yet). Architecture diagram in `docs/architecture.md` (Mermaid). | |
| Day 11 | Polish top-level README for recruiter-readability. Embed dashboard/alert/GKE screenshots. Add `bootstrap.sh` one-command recreate script. Add "Lessons learned" section from the gotchas below. | |
| Day 12 | Draft Resume A (Infra/Reliability) targeting DevOps + SRE jobs. Update LinkedIn project section. Write 2-3 paragraph project description for cover letters. | |

---

## Repository layout

```
~/projects/observashop/
├── README.md                          # placeholder, polished on Day 11
├── CLAUDE_CONTEXT.md                  # this document
├── .gitignore
├── .github/workflows/
│   └── ci.yaml                        # matrix build per service, Trivy gated, GHCR push
│
├── services/
│   ├── users-service/                 # TS + Postgres + chaos endpoint (image 0.3.0)
│   ├── products-service/               # TS + in-memory (image 0.1.0)
│   ├── orders-service/                # TS + Postgres + inter-service HTTP (image 0.1.0)
│   └── observashop-cli/               # Go + cobra + client-go (in progress, not yet containerized)
│
├── charts/
│   ├── microservice/                  # single reusable Helm chart
│   │   ├── Chart.yaml
│   │   ├── values.yaml                # defaults, overridden per-service
│   │   └── templates/                 # _helpers.tpl, deployment.yaml, service.yaml
│   └── values/
│       ├── users-service.yaml
│       ├── products-service.yaml
│       ├── orders-service.yaml
│       ├── kube-prometheus-stack.yaml
│       ├── loki.yaml                  # modern single-binary chart
│       ├── promtail.yaml
│       ├── slo-rules.yaml             # users-service PrometheusRule
│       ├── slo-rules-orders.yaml      # orders-service PrometheusRule
│       ├── grafana-dashboard-users-service.yaml
│       └── grafana-dashboard-slo.yaml
│
├── argocd/                            # ArgoCD Application CRDs
│   ├── users-service-app.yaml
│   ├── products-service-app.yaml
│   └── orders-service-app.yaml
│
└── infra/
    ├── kind/cluster.yaml              # 3-node kind config
    └── scripts/setup-local-registry.sh # needs containerd config_path append (see gotcha #3)
```

### Files notably absent (will be added on Day 8+)

- `terraform/` (Day 8)
- `docs/runbooks/`, `docs/postmortem.md`, `docs/architecture.md` (Day 10)
- `bootstrap.sh` one-command environment recreate script (Day 11)

---

## Naming conventions — follow these

- **Kubernetes labels:** standard `app.kubernetes.io/*` labels (name, instance, managed-by, version, part-of: observashop). Resources targeted by kube-prometheus-stack's selectors also need `release: kps`.
- **Prometheus metric names:** snake_case with unit suffix (`http_requests_total`, `http_request_duration_seconds`, `db_query_duration_seconds`, `http_client_request_duration_seconds`).
- **Recording rule names:** `<level>:<service>:<measurement>:<window>` — e.g., `sli:users_service:errors:rate5m`, `sli:orders_service:upstream_error_ratio:rate5m`.
- **Alert names:** `<Service><WhatIsWrong><BurnType>` in PascalCase — e.g., `UsersServiceErrorBudgetFastBurn`, `OrdersServiceUpstreamDegraded`. Always include `severity` and `slo` labels.
- **Image tags:** semver for manual builds (`0.3.0`), short commit SHA for CI builds. Never `latest` outside of the convenience tag pushed alongside SHA.
- **Git commits:** Conventional Commits format (`feat(scope): subject`, `fix(scope): subject`, etc.) with body bullets describing what and why, not which files. No emoji, no co-authoring tags.
- **Files:** kebab-case YAML, snake_case is wrong for this project, PascalCase is wrong for this project.

---

## Constraints and non-negotiables

Things Claude should never change or assume:

1. **Node.js stays.** Do not propose rewriting services in Go, Rust, or anything else. The Go CLI is the Go signal; services are Node.
2. **Single reusable Helm chart.** Do not suggest one chart per service. Services share `charts/microservice/`.
3. **ArgoCD is the source of truth.** After Day 5, no one runs `helm install` or `helm upgrade` on managed releases. Changes go through Git.
4. **CVE allowlist is documented.** Every `.trivyignore` entry must have: CVE ID, package, severity, justification with reachability analysis, risk level, review date. Never just "ignore this because it's annoying."
5. **Liveness != readiness.** Liveness probes must NOT check the database. Readiness probes do. This is deliberate and correct; don't "fix" it.
6. **Multi-window multi-burn-rate alerts.** Google SRE book pattern with 5m AND 1h windows. Do not simplify to single-window alerts.
7. **Recording rules before alerts.** Alerts reference pre-computed SLIs (`sli:...`). Don't inline raw PromQL histograms into alert expressions.
8. **Secrets from Kubernetes secrets, not env var strings.** Postgres password comes from `secretKeyRef` on `postgres-postgresql`. Do not hardcode.
9. **Services run as non-root with read-only root filesystem.** Pod security context is hardened. Don't relax it.
10. **Local registry is `localhost:5001`, not 5000.** 5000 conflicts with macOS AirPlay; 5001 is the portable choice.
11. **Commits must be atomic.** One logical change per commit. If Claude suggests running a command that produces uncommitted changes across multiple concerns, split them.
12. **Do not invent file paths.** Before writing code that references a file, ask or verify with `ls`/`cat`.

---

## Known issues and gotchas

These are real things that bit us. Document them in the Day 10 postmortem. More importantly, a new Claude should recognize them if they reappear.

1. **Cloudflare WARP intermittently blocks HTTPS inside WSL.** Symptom: `curl: (60) SSL certificate problem: certificate has expired`. Fix: toggle WARP off in the system tray, retry. Doesn't always reproduce. Kind image pulls from quay.io also hit this.
2. **Windows Node.js in the WSL PATH causes `tsc` to write to `C:\Windows\tsconfig.json`** with EPERM. Fix: install Linux Node via NodeSource so `/usr/bin/node` is first in PATH. Always open a fresh Ubuntu terminal after PATH changes.
3. **kind nodes cannot resolve `localhost:5001`** from inside containers. Fix requires two things: (a) containerd `hosts.toml` at `/etc/containerd/certs.d/localhost:5001/hosts.toml` pointing at `http://kind-registry:5000`, AND (b) containerd's main `config.toml` must have `[plugins."io.containerd.grpc.v1.cri".registry] config_path = "/etc/containerd/certs.d"` set. Missing the second part causes `ImagePullBackOff` with "connection refused" errors. `setup-local-registry.sh` script does NOT yet include the config_path append — needs fixing before Day 9.
4. **Bitnami `bitnami/postgresql:16` no longer exists on Docker Hub** (Bitnami moved their free images out in 2025). The Helm chart still works because it pulls from a different location, but ad-hoc client test pods must use `postgres:16-alpine` instead.
5. **Deprecated `loki-stack` chart ships Loki 2.6.1** which Grafana 12 cannot health-check (parser mismatch — "syntax error: unexpected IDENTIFIER"). Must use `grafana/loki` v3 single-binary chart instead.
6. **Grafana datasource UIDs are auto-generated** and do not match the human-readable name. Dashboard JSON that hardcodes `"uid": "loki"` will fail. Fix: query `http://localhost:3000/api/datasources` to get the actual UID and patch the ConfigMap. Same for Prometheus (`uid: "prometheus"` happens to match but don't rely on it).
7. **Moving Docker Desktop's disk image** (done on Day 4 to free C drive) corrupts file ownership in existing PVCs on shutdown/reboot. Grafana's `init-chown-data` container fails with "Permission denied" after every major Docker restart. Fix: `kubectl scale deployment kps-grafana --replicas=0`, delete the `kps-grafana` PVC, `helm upgrade kps ... --reuse-values` to recreate it. Lose Grafana's internal state (login history) but dashboards/datasources reload from ConfigMaps instantly. This will keep happening until we migrate off the PVC-based Grafana or move the cluster to cloud.
8. **kube-prometheus-stack's built-in kubelet rules throw `many-to-many matching not allowed`** warnings on kind clusters because all nodes share the same Docker IP. Cosmetic, does not affect functionality. Do not try to "fix" — document as known issue.
9. **The Prometheus `/rules` UI page is long and unsorted.** Use Ctrl+F to find specific rules, or query `/api/v1/rules` directly. Don't conclude "rules didn't load" just because you can't see them in the UI.
10. **Long-running `kubectl port-forward` dies when the terminal closes.** The cluster is fine. Just restart the port-forwards. Multiple stale port-forwards on the same port fail to bind — run `pkill -f "kubectl port-forward"` before restarting.
11. **Trivy flags transitive dev dependencies** like `picomatch` even when they only run at dev time. The production image is built with `--omit=dev` so the vulnerable code is never in the runtime image. Resolution: document in `.trivyignore` with reachability justification, not a panic.
12. **Newer Alpine base images sometimes still have the old OpenSSL package** when CVEs are very fresh. You can chase version tags (`node:22-alpine`, `node:22.11-alpine3.21`, etc.) only so far; at some point you accept the CVE with a documented reachability rationale.
13. **Express 5 has stricter TypeScript types** than Express 4. `req.params.id` is now `string | string[]`. Cast explicitly with `as string` when accessing.
14. **`fetch`'s `Response` type clashes with Express's `Response` type** when both are imported. In orders-service we alias the fetch one as `globalThis.Response` and rename the local variable from `res` to `r` to disambiguate.

---

## How to come back to this project

### If the cluster is still up

```bash
cd ~/projects/observashop
git status                        # should be clean
kubectl get nodes                 # 3 Ready
kubectl get pods -A | grep -v Running | grep -v Completed
kubectl get applications -n argocd  # 3 apps, all Synced + Healthy
```

If Grafana shows `Unknown` (common after restarts), apply gotcha #7's fix. If the local registry is missing, `docker start kind-registry`. If port-forwards are dead, just restart them as needed.

### If the cluster is gone entirely

Full rebuild takes ~30 minutes. See conversation history for the exact sequence. 

```bash
cd ~/projects/observashop
kind create cluster --config infra/kind/cluster.yaml
./infra/scripts/setup-local-registry.sh   # NOTE: needs containerd config_path append (gotcha #3)
kubectl create namespace observashop
kubectl create namespace monitoring

# Rebuild and push images locally
for svc in users-service products-service orders-service; do
  cd services/$svc
  docker build -t localhost:5001/observashop/$svc:0.1.0 .
  docker push localhost:5001/observashop/$svc:0.1.0
  cd ../..
done

# Postgres
helm repo add bitnami https://charts.bitnami.com/bitnami
helm install postgres bitnami/postgresql -n observashop \
  --set auth.username=observashop --set auth.password=observashop-dev-pw \
  --set auth.database=users --set primary.persistence.size=1Gi
kubectl exec -n observashop postgres-postgresql-0 -- bash -c \
  'PGPASSWORD=observashop-dev-pw psql -U observashop -d users -c "CREATE DATABASE orders;"'

# Services
helm install users-service ./charts/microservice -f charts/values/users-service.yaml -n observashop
helm install products-service ./charts/microservice -f charts/values/products-service.yaml -n observashop
helm install orders-service ./charts/microservice -f charts/values/orders-service.yaml -n observashop

# Observability
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo add grafana https://grafana.github.io/helm-charts
helm install kps prometheus-community/kube-prometheus-stack -n monitoring -f charts/values/kube-prometheus-stack.yaml
helm install loki grafana/loki -n monitoring -f charts/values/loki.yaml
helm install promtail grafana/promtail -n monitoring -f charts/values/promtail.yaml
kubectl apply -f charts/values/grafana-dashboard-users-service.yaml
kubectl apply -f charts/values/grafana-dashboard-slo.yaml
kubectl apply -f charts/values/slo-rules.yaml
kubectl apply -f charts/values/slo-rules-orders.yaml
# Loki datasource ConfigMap — see conversation history, not yet in repo

# ArgoCD
kubectl create namespace argocd
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/v2.13.1/manifests/install.yaml
# After argocd-server is Running, apply the Application manifests
kubectl apply -f argocd/
```

This will be wrapped into `bootstrap.sh` on Day 11.

---

## Panic button

If a Claude in any chat starts confidently inventing things — naming files that don't exist, referencing ports we never set, making decisions without asking — stop it immediately and come back to whichever chat last had working context. A healthy Claude reading this document will ask 1-3 clarifying questions before writing code. A dangerous one will pretend to know everything. The instinct to ask is the safety signal.

---

*End of brief. Ayush is currently mid-Day-7. Next action: finish Day 7 by writing a Dockerfile for observashop-cli, adding it to CI, and committing.*
