# ObservaShop Terraform

Terraform modules and environments for provisioning ObservaShop infrastructure on GCP.

## Layout

- `modules/vpc/` — Reusable VPC + subnet with secondary ranges for GKE
- `modules/gke/` — Reusable regional GKE cluster + managed node pool
- `environments/dev/` — Dev environment composition

## One-time bootstrap (already done)

Before `terraform init` can run, the GCS state bucket must exist. This was created manually:
gcloud storage buckets create gs://observashop-dev-202604-tfstate
--project=observashop-dev-202604 
--location=us-central1 
--uniform-bucket-level-access
gcloud storage buckets update gs://observashop-dev-202604-tfstate --versioning
Required APIs enabled on the project:

- compute.googleapis.com
- container.googleapis.com
- iam.googleapis.com
- cloudresourcemanager.googleapis.com
- storage.googleapis.com
- serviceusage.googleapis.com

## Usage
cd terraform/environments/dev
terraform init
terraform plan -out=tfplan
terraform apply tfplan        # Day 9 only — provisions real cloud resources
terraform destroy             # Day 9 cleanup — destroys all resources
## Cost guardrails

- Regional GKE cluster (~$0.10/hr for control plane)
- 3 x e2-medium nodes (~$0.10/hr total)
- Total: ~$0.20/hr; ~$0.50 for a 2-hour demo window

Never leave applied. Always `terraform destroy` after demo.

## Authentication

Uses Application Default Credentials. Set up on a new machine with:
gcloud auth application-default login
gcloud auth application-default set-quota-project observashop-dev-202604
