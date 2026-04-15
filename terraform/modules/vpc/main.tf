resource "google_compute_network" "this" {
  project                 = var.project_id
  name                    = "observashop-${var.environment}-vpc"
  auto_create_subnetworks = false
  routing_mode            = "REGIONAL"

  description = "ObservaShop ${var.environment} VPC"
}

resource "google_compute_subnetwork" "gke_nodes" {
  project       = var.project_id
  name          = "observashop-${var.environment}-gke-nodes"
  region        = var.region
  network       = google_compute_network.this.id
  ip_cidr_range = var.subnet_cidr

  private_ip_google_access = true

  secondary_ip_range {
    range_name    = "pods"
    ip_cidr_range = var.pods_cidr
  }

  secondary_ip_range {
    range_name    = "services"
    ip_cidr_range = var.services_cidr
  }

  log_config {
    aggregation_interval = "INTERVAL_5_SEC"
    flow_sampling        = 0.5
    metadata             = "INCLUDE_ALL_METADATA"
  }
}
