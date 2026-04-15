variable "project_id" {
  description = "GCP project ID where the cluster is created"
  type        = string
}

variable "region" {
  description = "GCP region for the regional cluster"
  type        = string
}

variable "environment" {
  description = "Environment name, used in resource naming"
  type        = string
}

variable "network_id" {
  description = "Self-link of the VPC network for the cluster"
  type        = string
}

variable "subnet_id" {
  description = "Self-link of the subnet for cluster nodes"
  type        = string
}

variable "pods_range_name" {
  description = "Name of the secondary range for pods"
  type        = string
}

variable "services_range_name" {
  description = "Name of the secondary range for services"
  type        = string
}

variable "node_count" {
  description = "Number of nodes per zone in the node pool"
  type        = number
  default     = 1
}

variable "machine_type" {
  description = "Machine type for node pool nodes"
  type        = string
  default     = "e2-medium"
}

variable "disk_size_gb" {
  description = "Boot disk size per node"
  type        = number
  default     = 50
}
