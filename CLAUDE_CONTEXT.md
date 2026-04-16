# ObservaShop — Project Brief

**Read this doc first. Don't make any assumptions outside of it. Ask me before deviating.**

---

## What the project is

ObservaShop is a production-grade microservice platform built on Kubernetes as a portfolio project for Ayush Gupta (CS undergrad, May 2026 graduate) to demonstrate end-to-end DevOps, SRE, and backend engineering skills for off-campus fresher job applications. The goal is a 90+ ATS score across DevOps and SRE resume targets. It is a single project across roughly 12 working days that builds a real observable, alerting, GitOps-driven, chaos-tested microservice platform — intentionally over-engineered for a fresher project because the over-engineering *is* the resume. Priority order of target roles: DevOps > SRE > SWE > AI/ML > Data Analyst. This project serves the first three; AI/ML is handled by separate existing projects (Crop Yield with CatBoost, ClipArt AI).

**Repo:** <https://github.com/ayushgupta07xx/observashop>

---

## Tech stack and key decisions already made

These are locked in. Do not re-litigate.

* **Host environment:** Windows 11 with WSL2 Ubuntu 22.04. All work happens inside WSL. Editor is VS Code with the WSL extension. Docker Desktop with WSL2 backend, disk image relocated to `E:\DockerDesktop` (was moved mid-project to free C drive space).
* **Kubernetes:** kind v0.23.0 running 3 nodes (1 control plane + 2 workers). Cluster name is `observashop`. Kubernetes v1.30. Why kind and not minikube/k3d: kind is what the Kubernetes project uses internally, supports multi-node easily, best containerd story.
* **Microservices:** Node.js 20 + TypeScript + Express 5. Why Node: already on Ayush's resume, small images, fast startup, the point of the project is the infra around the services not the services themselves. Go is added separately as a CLI tool (Day 7) for credible "I write Go" claim without rewriting working services.
* **Observability stack:** `kube-prometheus-stack` (Prometheus + Alertmanager + Grafana + node-exporter + kube-state-metrics, all via the community Helm chart). Loki via the modern `grafana/loki` v3 single-binary chart — NOT the deprecated `loki-stack` chart which ships Loki 2.6.1 that Grafana 12 can't health-check. Promtail DaemonSet for log shipping. Metrics use `prom-client`, logs use `pino`.
* **Packaging:** One reusable Helm chart (`charts/microservice/`) parameterized by per-service values files. All services use the same chart. Rationale: DRY, and real platform teams work this way.
* **GitOps:** ArgoCD manages Helm releases via `Application` CRDs with `automated.prune`, `automated.selfHeal`, and `ServerSideApply`. Git is the source of truth. No more `helm install` from laptop after Day 5.
* **CI/CD:** GitHub Actions with path-filtered matrix builds (one job per service, skips services that didn't change). Trivy scans gate on CRITICAL/HIGH CVEs. Accepted-risk CVEs live in per-service `.trivyignore` files with documented justifications (package, severity, reachability analysis, review date). Images pushed to GitHub Container Registry (`ghcr.io/ayushgupta07xx/observashop/<service>`) on main branch only, tagged with short commit SHA. Matrix entries carry a `language` field (`node` or `go`) so language-specific steps (npm install, tsc build) only run for the services that need them.
* **Image registries:** Two in play. Local `localhost:5001` via a `registry:2` container wired into the kind Docker network (for local dev — Helm values point here). `ghcr.io/ayushgupta07xx/observashop/<service>` for CI-built images, public, accessible to recruiters. As of Day 7, this includes `observashop-cli` (the Go binary).
* **Database:** PostgreSQL 16 via Bitnami Helm chart. Single instance, two databases: `users` and `orders`. 1 GiB PVC. Credentials via Helm secret (`postgres-postgresql`), referenced by services through `secretKeyRef`.
* **SLOs:** Defined as PrometheusRule CRDs with recording rules over 5m/30m/1h/6h windows. Multi-window multi-burn-rate alerts following the Google SRE book pattern (burn rates 14.4x, 6x, 3x, 1x). Targets: 99.9% availability, p99 latency < 250ms (users-service) / < 500ms (orders-service, higher because it fans out to upstreams). Alerts fire Inactive -> Pending -> Firing as designed and were verified by deliberate chaos injection.
* **Chaos testing:** Runtime fault injection via in-service `/chaos/error-rate` and `/chaos/latency` endpoints on users-service. Pattern: real fault injection as Envoy/Istio do it, not a separate tool. LitmusChaos and Chaos Mesh are mentioned as "production-grade equivalents" for interview context only, not installed.
* **Go CLI (Day 7):** Built with `cobra` + `client-go`. Uses in-cluster config when running as a pod, falls back to `~/.kube/config` when local. Containerized as a multi-stage Dockerfile: `golang:1.25-alpine` builder → `gcr.io/distroless/static-debian12:nonroot` runtime. Final image ~12 MB. Static binary built with `CGO_ENABLED=0`, `-trimpath`, `-ldflags="-s -w"`. Both code paths (in-cluster and local kubeconfig) verified working against the kind cluster.
* **Cloud (Day 8+):** GCP project `observashop-dev-202604` in region `us-central1`. Billing account linked. Required APIs enabled (compute, container, iam, cloudresourcemanager, storage, serviceusage). Application Default Credentials (ADC) configured for Terraform via `gcloud auth application-default login`. State stored in GCS bucket `observashop-dev-202604-tfstate` with versioning enabled and uniform bucket-level access.
* **Terraform:** v1.9.8 on WSL. Google provider `~> 6.0`. Module layout: `terraform/modules/{vpc,gke}` reusable, `terraform/environments/dev` composition. Regional GKE cluster (HA control plane across 3 zones in us-central1), separate managed node pool (best practice), dedicated least-privilege service account, Workload Identity enabled, shielded nodes, Calico network policy, REGULAR release channel, `deletion_protection = false` so `terraform destroy` works on Day 9. `terraform plan` is green; no `apply` until Day 9.

---

## Branching, tagging, and rollback discipline

This was established at the end of Day 7 and is now standard for the rest of the project.

* **Each day's work happens on a feature branch** named `feat/<short-description>` (e.g. `feat/cli-containerize`, `feat/terraform-gke`). Never commit directly to main.
* **Each day ends with a tag** on main once the day's PR is merged. Naming: `day-N-complete`. Tags are pushed to GitHub: `git push origin day-N-complete`.
* **Optionally** a `day-N-pre-X` tag can be created at the start of a day to mark "before today's work" if the day involves a major or risky change.
* **Existing tags as of end-of-Day-8:**
  + `day-7-pre-cli` — main as it stood before any Day 7 containerization work
  + `day-7-complete` — Day 7 fully complete, CLI containerized and in CI
  + `day-8-complete` — Day 8 fully complete, Terraform plan succeeding
  + `day-9-complete` — Day 9 fully complete, GKE deployment recorded and destroyed
  + `day-10-complete` — Day 10 fully complete, postmortem, runbooks, architecture diagram, alert annotations
* **Rollback options if a future day breaks something:** (1) `git revert <bad-commit>` for surgical undo, (2) `git checkout day-N-complete` to inspect a past state read-only, (3) `git checkout -b restart-from-day-N day-N-complete` to branch off a known-good point and try again, (4) `git reset --hard day-N-complete && git push --force-with-lease` as a nuclear last resort.
* **A new chat continuing the project should always start with:** confirm we're on main, working tree clean, last tag is `day-N-complete`, ready to start Day N+1.

---

## Current state

### What's done (Days 1-10 complete as of this document)

1. **Day 1:** WSL2 Ubuntu, Docker Desktop, kubectl, kind, Helm, Terraform, Git, GitHub repo created with first commit.
2. **Day 2:** users-service written in TypeScript with `/healthz`, `/readyz`, `/metrics`, pg-less CRUD; multi-stage hardened Dockerfile; 3-node kind cluster running; deployed via raw manifests.
3. **Day 3:** products-service (second service); local Docker registry wired into kind; both services converted to use a single reusable `charts/microservice/` Helm chart with per-service values. Postgres installed via Bitnami chart, users-service rewritten to use it with connection pool, schema migration with retry-until-ready, readiness probe checks DB.
4. **Day 4 (the heaviest day):** Full observability stack. kube-prometheus-stack installed. Loki + Promtail (after migrating from deprecated loki-stack to modern grafana/loki). Custom "ObservaShop - Users Service" Grafana dashboard as a ConfigMap with request rate, error rate, latency percentiles, DB query latency, healthy pods, live log panel. PrometheusRule with SLI recording rules and multi-window burn-rate alerts. SLO dashboard with availability, latency, and error-budget burn rate stat panels. Chaos endpoint added to users-service. End-to-end verified: injected 100% error rate -> `UsersServiceErrorBudgetFastBurn` transitioned Inactive -> Pending -> Firing within ~5 minutes. Scaled replicas to 1 -> `UsersServicePodNotReady` fired within ~3 min. Screenshots of both Firing states saved.
5. **Day 5:** ArgoCD installed. users-service and products-service converted to ArgoCD Applications with auto-sync, self-heal, prune, and ServerSideApply. GitOps loop verified (changed `replicaCount` in Git -> cluster scaled automatically). GitHub Actions CI pipeline with matrix per service, Trivy scanning, GHCR publishing. Real CVE remediation story: Trivy caught node-tar, picomatch, zlib, and OpenSSL CVEs across multiple iterations. Fixed what could be fixed (base image bumps, npm `overrides` for picomatch), documented what couldn't with `.trivyignore` and reachability analysis. Final pipeline run was green; images visible at <https://github.com/ayushgupta07xx?tab=packages>.
6. **Day 6:** orders-service (third service) with inter-service HTTP calls to users-service and products-service. Instrumented with `http_client_request_duration_seconds` histogram. 5-second timeout via `AbortSignal.timeout`. New `OrdersServiceUpstreamDegraded` alert fires before the service's own error budget burns — early-warning dependency pattern. Wired into ArgoCD, CI matrix, and the SLO framework (`slo-rules-orders.yaml` PrometheusRule). Latency SLO is 500ms (higher than users-service's 250ms because orders fans out).
7. **Day 7:** `observashop-cli` Go binary built with cobra + client-go. Four subcommands: `health` (pings /healthz on all services in parallel with latency reporting), `chaos` (wraps users-service chaos endpoints), `pods` (client-go List), `slo-status` (queries Prometheus /api/v1/alerts for alerts with an `slo` label). Auto-detects in-cluster vs local kubeconfig. Containerized with multi-stage Dockerfile (`golang:1.25-alpine` → distroless static nonroot, ~12 MB). Real CVE remediation: Trivy initially flagged 8 CVEs (1 CRITICAL, 7 HIGH) in Go stdlib and `golang.org/x/oauth2`; bumped Go toolchain version (1.23.4 → 1.25-alpine) and oauth2 (0.21.0 → 0.27+), all 8 cleared. Added to CI matrix with `language: node|go` field gating Node-specific steps. Image published to `ghcr.io/ayushgupta07xx/observashop/observashop-cli`. In-cluster code path verified by running the CLI as a one-shot pod via `kubectl run`.
8. **Day 8:** GCP account created, billing linked (₹1000 refundable deposit, $300 trial credit active). Project `observashop-dev-202604` in `us-central1`. gcloud CLI installed and authenticated in WSL (both user and ADC). Six required APIs enabled. GCS state bucket `observashop-dev-202604-tfstate` created with versioning + uniform bucket-level access. Terraform module structure built: reusable `vpc` and `gke` modules under `terraform/modules/`, dev composition under `terraform/environments/dev`. GKE cluster spec is regional (HA across 3 zones), separate managed node pool, dedicated least-privilege service account, Workload Identity, shielded nodes, Calico network policy, REGULAR release channel. `terraform plan` succeeds: 9 resources to add. No `terraform apply` yet — that's Day 9.
9. **Day 9:** Real GKE cluster spun up via `terraform apply`, ObservaShop deployed end-to-end, demo video recorded, then `terraform destroy`. Total spend: ~$0.65 USD on the trial credit. Hit four real gotchas worth documenting: (a) GKE's bootstrap default-pool used 3×100GB pd-balanced disks during cluster creation even with `remove_default_node_pool=true`, blowing the non-adjustable 250GB SSD quota on free trial accounts — fix was adding a top-level `node_config { disk_size_gb=20, disk_type="pd-standard" }` block to override the bootstrap pool's disk; (b) Bitnami's Helm chart v18+ pulls itself as an OCI artifact from Docker Hub, which triggers Docker Desktop's Windows credential helper from inside WSL and fails with `exec format error` — fix was setting `DOCKER_CONFIG=/tmp/empty-docker-config` to skip the broken helper; (c) 3×e2-medium (≈3 vCPU usable) is too small for kube-prometheus-stack + 3 services; resized node pool to 6 nodes mid-deployment via `gcloud container clusters resize --num-nodes 2` (per-zone × 3 zones); (d) GCP zonal capacity churn caused one node to repair-loop continuously throughout the demo (`compute.instances.repair.recreateInstance` operations every ~10 min, "instance should be RUNNING, but it doesn't exist") — cosmetic, didn't block the demo, documented as known limitation. Six screenshots captured: GKE console (5 nodes healthy), kubectl get nodes, Grafana users-service dashboard with live traffic, SLO dashboard healthy state, SLO dashboard burning at 81% availability / 187x burn rate, Prometheus alert UsersServiceErrorBudgetFastBurn FIRING. 2-minute demo video recorded with OBS. After destroy, 4 orphan PVC disks remained (Kubernetes-created, outside Terraform state) — cleaned up manually with `gcloud compute disks delete`. Final state: zero GCP resources, zero billing, all work on `feat/gke-deployment` branch.
10. **Day 10:** Documentation day. `docs/postmortem.md` — full incident write-up of the Day 4 chaos test (`UsersServiceErrorBudgetFastBurn` injection, Inactive → Pending → Firing in ~12 min) with IST timestamps, root cause analysis, detection matrix, what went well/poorly, action items, plus Day 9 GKE gotchas as a secondary lessons-learned section. 5 runbooks in `docs/runbooks/` covering all 9 alerts: `users-service-errors.md`, `orders-service-errors.md`, `latency-slo-burn.md`, `pod-not-ready.md`, `upstream-degraded.md`. `docs/architecture.md` with Mermaid flowchart (GitHub renders natively) showing kind/GKE deployment paths, service dependencies, observability fan-in, ArgoCD GitOps loop, CI/CD pipeline. All 9 PrometheusRule alerts updated with `Runbook:` annotation links pointing at the runbook files. 4 atomic commits on `feat/docs-day10` branch, PR #4 merged to main.

### What's next

| Day | Work | Notes |
| --- | --- | --- |
| Day 11 | Polish top-level README for recruiter-readability. Embed dashboard/alert/GKE screenshots. Add `bootstrap.sh` one-command recreate script. Add "Lessons learned" section from the gotchas below. Optional: add `terraform fmt -check` and `terraform validate` as CI gates. |  |
| Day 12 | Draft Resume A (Infra/Reliability) targeting DevOps + SRE jobs. Update LinkedIn project section. Write 2-3 paragraph project description for cover letters. |  |

---

## Repository layout

```
~/projects/observashop/
├── README.md                          # placeholder, polished on Day 11
├── CLAUDE_CONTEXT.md                  # this document
├── .gitignore
├── .github/workflows/
│   └── ci.yaml                        # matrix build per service (language-aware), Trivy gated, GHCR push
│
├── services/
│   ├── users-service/                 # TS + Postgres + chaos endpoint (image 0.3.0)
│   ├── products-service/              # TS + in-memory (image 0.1.0)
│   ├── orders-service/                # TS + Postgres + inter-service HTTP (image 0.1.0)
│   └── observashop-cli/               # Go + cobra + client-go, containerized, in CI
│       ├── Dockerfile                 # multi-stage, distroless static nonroot runtime
│       ├── .dockerignore
│       ├── .gitignore                 # ignores bin/
│       ├── .trivyignore               # placeholder, currently empty (CVEs all fixed by version bumps)
│       ├── go.mod / go.sum
│       ├── main.go
│       └── cmd/                       # health.go, chaos.go, pods.go, slo.go, root.go
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
├── terraform/                         # GCP infrastructure (Day 8+)
│   ├── README.md                      # bootstrap docs and usage
│   ├── .gitignore                     # ignores .terraform/, tfplan, *.tfstate*, etc.
│   ├── modules/
│   │   ├── vpc/                       # VPC + subnet with secondary ranges for VPC-native GKE
│   │   └── gke/                       # regional GKE cluster + managed node pool + SA + IAM
│   └── environments/
│       └── dev/
│           ├── main.tf                # composition wiring vpc + gke modules
│           ├── variables.tf
│           ├── terraform.tfvars       # project_id, region (committed; only public values)
│           ├── backend.tf             # GCS backend pointing at observashop-dev-202604-tfstate
│           ├── versions.tf            # pins Terraform >= 1.9.0, google ~> 6.0
│           └── .terraform.lock.hcl    # committed for reproducibility
├── docs/
│   ├── postmortem.md                  # Day 4 chaos test incident write-up
│   ├── architecture.md                # Mermaid system architecture diagram
│   └── runbooks/
│       ├── users-service-errors.md
│       ├── orders-service-errors.md
│       ├── latency-slo-burn.md
│       ├── pod-not-ready.md
│       └── upstream-degraded.md
│
└── infra/
    ├── kind/cluster.yaml              # 3-node kind config
    └── scripts/setup-local-registry.sh
    
```

### Files notably absent (will be added later)

* `bootstrap.sh` one-command environment recreate script (Day 11)

---

## Naming conventions — follow these

* **Kubernetes labels:** standard `app.kubernetes.io/*` labels (name, instance, managed-by, version, part-of: observashop). Resources targeted by kube-prometheus-stack's selectors also need `release: kps`.
* **Prometheus metric names:** snake\_case with unit suffix (`http_requests_total`, `http_request_duration_seconds`, `db_query_duration_seconds`, `http_client_request_duration_seconds`).
* **Recording rule names:** `<level>:<service>:<measurement>:<window>` — e.g., `sli:users_service:errors:rate5m`, `sli:orders_service:upstream_error_ratio:rate5m`.
* **Alert names:** `<Service><WhatIsWrong><BurnType>` in PascalCase — e.g., `UsersServiceErrorBudgetFastBurn`, `OrdersServiceUpstreamDegraded`. Always include `severity` and `slo` labels.
* **Image tags:** semver for manual builds (`0.3.0`), short commit SHA for CI builds. Never `latest` outside of the convenience tag pushed alongside SHA.
* **Git commits:** Conventional Commits format (`feat(scope): subject`, `fix(scope): subject`, etc.) with body bullets describing what and why, not which files. No emoji, no co-authoring tags.
* **Git branches:** `feat/<short-description>` for day-by-day work. Merge into main via PR.
* **Git tags:** `day-N-complete` at the end of each day, pushed to origin. Optionally `day-N-pre-<thing>` at start of risky day.
* **Files:** kebab-case YAML, snake\_case is wrong for this project, PascalCase is wrong for this project.
* **GCP resources (Terraform):** `observashop-<env>-<resource-type>` (e.g. `observashop-dev-vpc`, `observashop-dev-gke-nodes`). Service accounts: `gke-<env>-nodes`. Labels: `environment`, `managed_by = "terraform"`, `project = "observashop"`.

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
13. **No `terraform apply` outside of Day 9.** Day 8's deliverable was `terraform plan` only. Day 9 is the controlled apply-then-destroy window. Any future day that needs cloud must be a deliberate decision with budget impact discussed first.
14. **All work happens on feature branches.** Never commit to main. Tag main as `day-N-complete` after merging the day's PR.

---

## Known issues and gotchas

These are real things that bit us. Document them in the Day 10 postmortem. More importantly, a new Claude should recognize them if they reappear.

1. **Cloudflare WARP intermittently blocks HTTPS inside WSL.** Symptom: `curl: (60) SSL certificate problem: certificate has expired`. Fix: toggle WARP off in the system tray, retry. Doesn't always reproduce. Kind image pulls from quay.io also hit this.
2. **Windows Node.js in the WSL PATH causes `tsc` to write to `C:\Windows\tsconfig.json`** with EPERM. Fix: install Linux Node via NodeSource so `/usr/bin/node` is first in PATH. Always open a fresh Ubuntu terminal after PATH changes.
3. **kind nodes cannot resolve `localhost:5001`** from inside containers. Fix requires two things: (a) containerd `hosts.toml` at `/etc/containerd/certs.d/localhost:5001/hosts.toml` pointing at `http://kind-registry:5000`, AND (b) containerd's main `config.toml` must have `[plugins."io.containerd.grpc.v1.cri".registry] config_path = "/etc/containerd/certs.d"` set. Missing the second part causes `ImagePullBackOff` with "connection refused" errors. `setup-local-registry.sh` script does NOT yet include the config\_path append — needs fixing before Day 9.
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
15. **Trivy on Go binaries scans compiled-in stdlib and module deps.** A fresh `go build` with an older Go toolchain (e.g. 1.23) will surface stdlib CVEs (CVE-2025-68121, CVE-2025-47907, etc.) that are fixed in newer Go versions. Fix: bump the Dockerfile builder image to a current Go (e.g. `golang:1.25-alpine`); your local `go.mod` `go 1.23` directive can stay because it's a *minimum* version, not a maximum. Module-level CVEs (e.g. `golang.org/x/oauth2 < 0.27.0`) are fixed by `go get <module>@latest && go mod tidy` then rebuilding.
16. **gcloud auth in WSL is finicky.** `gcloud auth application-default login` (no flags) fails with `gio: Operation not supported` because WSL's gio can't talk to Windows browsers. `--no-browser` mode is for a different scenario (you need gcloud installed on a *second* machine with a browser). `--no-launch-browser` is broken on Google's end for some accounts (scope mismatch crash). The reliable fix on Windows 11: install Firefox inside WSL (`sudo apt-get install -y firefox`), which works via WSLg, and rerun the original `gcloud auth application-default login` with no flags. After auth succeeds, also run `gcloud auth application-default set-quota-project <project-id>` to fix the "no quota project" warning that otherwise breaks API quota tracking.
17. **GCP free trial in India requires a ₹1000 refundable prepayment** (not the case in all regions). The deposit is a credit balance, not a charge — your $300 trial credit covers actual GCP costs and the deposit only gets touched if those run out. Set a billing budget alert before doing any `terraform apply` to catch runaway costs.
18. **GKE bootstrap default-pool ignores `remove_default_node_pool` for disk sizing.** Even with `remove_default_node_pool = true` on a regional cluster, GKE still creates a temporary default node pool during `terraform apply` to bootstrap the cluster. That bootstrap pool defaults to 100 GB pd-balanced disks per node × 3 zones = 300 GB SSD. Free-trial GCP accounts have a non-adjustable 250 GB SSD quota in `us-central1`, so creation fails with `Quota 'SSD_TOTAL_GB' exceeded`. Fix: add a top-level `node_config { disk_size_gb = 20, disk_type = "pd-standard" }` block on the `google_container_cluster` resource itself (separate from the managed node pool's own `node_config`). The bootstrap pool still gets created and deleted seconds later, but with throwaway pd-standard disks. Note: COS image has a 12 GB minimum, so don't go below `disk_size_gb = 20` for headroom.

19. **Bitnami's Helm chart v18+ pulls itself as an OCI artifact from Docker Hub** (`oci://registry-1.docker.io/bitnamicharts/postgresql`). On WSL with Docker Desktop installed, the OCI pull triggers Docker's credential helper chain, which calls `docker-credential-desktop.exe` — a Windows binary — from inside WSL Linux. Result: `fork/exec /mnt/c/Program Files/Docker/Docker/resources/bin/docker-credential-desktop.exe: exec format error`. The Bitnami OCI registry is public and needs no auth, so the cleanest fix is to point Helm at an empty Docker config for the install: `DOCKER_CONFIG=/tmp/empty-docker-config helm install postgres oci://registry-1.docker.io/bitnamicharts/postgresql ...`. Affects every chart that has migrated to OCI distribution; will likely hit more charts over time.

20. **Kubernetes-created PVC-backed disks survive `terraform destroy`.** Anything Kubernetes provisioned dynamically (Grafana PVC, Prometheus PVC, Alertmanager PVC, etc.) lives in GCP as a `compute.disks` resource owned by the GKE cluster's storage class — not by Terraform. When `terraform destroy` removes the cluster, the disks are orphaned: still billable, invisible to `terraform state list`. After every destroy, run `gcloud compute disks list --project=<project>` and manually delete any leftovers with `gcloud compute disks delete <name> --zone=<zone>`. On Day 9 this was 4 disks totaling 8 GB pd-balanced. Cost is negligible per disk but accumulates if ignored across multiple test runs.

21. **GCP zonal capacity churn causes continuous node repair loops on small machine types in regional clusters.** With a regional GKE cluster on `e2-medium`, GCP can preempt or fail to provision a VM in a specific zone if backing capacity is tight. GKE responds by issuing `compute.instances.repair.recreateInstance` operations every ~10–20 min ("instance should be RUNNING, but it doesn't exist"). Visible in `gcloud compute operations list`. Cosmetic — the cluster remains usable as long as the other zones are healthy — but pods on the affected node get evicted and rescheduled repeatedly. No clean fix on the free tier; either pin to a single zone (zonal cluster, loses HA), use a larger machine type, or accept the churn. Documented as known limitation of cost-constrained free-tier GKE on `e2-medium`.

---

## How to come back to this project

### If the cluster is still up

```
cd ~/projects/observashop
git status                        # should be clean
git log --oneline -5              # confirm latest tag is day-N-complete
kubectl get nodes                 # 3 Ready
kubectl get pods -A | grep -v Running | grep -v Completed
kubectl get applications -n argocd  # 3 apps, all Synced + Healthy
```

If Grafana shows `Unknown` (common after restarts), apply gotcha #7's fix. If the local registry is missing, `docker start kind-registry`. If port-forwards are dead, just restart them as needed.

### If the cluster is gone entirely

Full rebuild takes ~30 minutes. See conversation history for the exact sequence.

```
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

### If GCP credentials are gone (new machine or expired ADC)

```
gcloud auth login                                                    # human auth
gcloud auth application-default login                                # ADC for Terraform (use Firefox in WSL — gotcha #16)
gcloud config set project observashop-dev-202604
gcloud auth application-default set-quota-project observashop-dev-202604
```

---

## Panic button

If a Claude in any chat starts confidently inventing things — naming files that don't exist, referencing ports we never set, making decisions without asking — stop it immediately and come back to whichever chat last had working context. A healthy Claude reading this document will ask 1-3 clarifying questions before writing code. A dangerous one will pretend to know everything. The instinct to ask is the safety signal.

---

*End of brief. Day 10 is complete and tagged. Next action: Day 11 — polish top-level README for recruiter-readability, embed screenshots, add bootstrap.sh one-command recreate script, add "Lessons learned" section. Optional: terraform fmt/validate CI gates. No cloud, no cluster work.*
