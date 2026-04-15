output "network_id" {
  description = "Self-link of the VPC network"
  value       = google_compute_network.this.id
}

output "network_name" {
  description = "Name of the VPC network"
  value       = google_compute_network.this.name
}

output "subnet_id" {
  description = "Self-link of the GKE node subnet"
  value       = google_compute_subnetwork.gke_nodes.id
}

output "subnet_name" {
  description = "Name of the GKE node subnet"
  value       = google_compute_subnetwork.gke_nodes.name
}

output "pods_range_name" {
  description = "Secondary range name for GKE pods"
  value       = "pods"
}

output "services_range_name" {
  description = "Secondary range name for GKE services"
  value       = "services"
}
