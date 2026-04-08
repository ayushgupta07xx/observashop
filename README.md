# ObservaShop

A production-grade microservice platform built to demonstrate modern DevOps and SRE practices end-to-end: GitOps deployments, full observability, defined SLOs, chaos engineering, and incident response.

## Status
🚧 Under active development

## Planned Architecture
- 3 microservices (users, products, orders) in Node.js / TypeScript
- PostgreSQL + Redis
- Kubernetes (kind locally, GKE for cloud demo)
- Helm charts managed via ArgoCD (GitOps)
- Terraform for cloud infrastructure
- GitHub Actions CI/CD with Trivy security scanning
- Prometheus + Grafana + Loki observability stack
- SLO definitions with burn-rate alerts
- LitmusChaos for chaos engineering experiments

## Author
Ayush Gupta — [LinkedIn](https://linkedin.com/in/ayush-gupta-544a803a2) · [GitHub](https://github.com/ayushgupta07xx)