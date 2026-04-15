variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "region" {
  description = "GCP region for all regional resources"
  type        = string
  default     = "us-central1"
}

variable "environment" {
  description = "Environment name, used in resource naming and labels"
  type        = string
  default     = "dev"
}

variable "gke_node_count" {
  description = "Number of nodes per zone in the GKE node pool"
  type        = number
  default     = 1
}

variable "gke_machine_type" {
  description = "Machine type for GKE node pool nodes"
  type        = string
  default     = "e2-medium"
}
