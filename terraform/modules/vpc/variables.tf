variable "project_id" {
  description = "GCP project ID where the VPC is created"
  type        = string
}

variable "region" {
  description = "GCP region for the subnet"
  type        = string
}

variable "environment" {
  description = "Environment name, used in resource naming"
  type        = string
}

variable "subnet_cidr" {
  description = "Primary CIDR range for the GKE node subnet"
  type        = string
  default     = "10.10.0.0/20"
}

variable "pods_cidr" {
  description = "Secondary CIDR range for GKE pods (VPC-native)"
  type        = string
  default     = "10.20.0.0/16"
}

variable "services_cidr" {
  description = "Secondary CIDR range for GKE services (VPC-native)"
  type        = string
  default     = "10.30.0.0/20"
}
