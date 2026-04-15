# Dedicated service account for GKE nodes (least-privilege)
# Default GCE service account has Editor role on the project, which is too broad.
resource "google_service_account" "gke_nodes" {
  project      = var.project_id
  account_id   = "gke-${var.environment}-nodes"
  display_name = "GKE ${var.environment} node service account"
}

# Minimum roles for GKE nodes to function
resource "google_project_iam_member" "gke_nodes_log_writer" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.gke_nodes.email}"
}

resource "google_project_iam_member" "gke_nodes_metric_writer" {
  project = var.project_id
  role    = "roles/monitoring.metricWriter"
  member  = "serviceAccount:${google_service_account.gke_nodes.email}"
}

resource "google_project_iam_member" "gke_nodes_monitoring_viewer" {
  project = var.project_id
  role    = "roles/monitoring.viewer"
  member  = "serviceAccount:${google_service_account.gke_nodes.email}"
}

resource "google_project_iam_member" "gke_nodes_artifact_reader" {
  project = var.project_id
  role    = "roles/artifactregistry.reader"
  member  = "serviceAccount:${google_service_account.gke_nodes.email}"
}

# Regional GKE cluster (control plane in 3 zones, HA)
# remove_default_node_pool=true is best practice — we manage the node pool separately
resource "google_container_cluster" "this" {
  project  = var.project_id
  name     = "observashop-${var.environment}"
  location = var.region

  network    = var.network_id
  subnetwork = var.subnet_id

  # We delete the default node pool immediately and create our own below
  remove_default_node_pool = true
  initial_node_count       = 1

  # Bootstrap default-pool gets minimal pd-standard disks to avoid hitting
  # SSD quota on free-trial accounts. Pool is deleted immediately after
  # cluster creation (remove_default_node_pool = true), so these disks
  # are short-lived. Real workload disks are configured on the primary
  # node pool below.
  node_config {
    disk_size_gb = 20
    disk_type    = "pd-standard"
  }

  # VPC-native networking (modern default, required for many features)
  ip_allocation_policy {
    cluster_secondary_range_name  = var.pods_range_name
    services_secondary_range_name = var.services_range_name
  }

  # Workload Identity — modern way for pods to authenticate to GCP services
  workload_identity_config {
    workload_pool = "${var.project_id}.svc.id.goog"
  }

  # Disable basic auth and client cert (security baseline)
  master_auth {
    client_certificate_config {
      issue_client_certificate = false
    }
  }

  # Release channel — REGULAR balances new features with stability
  release_channel {
    channel = "REGULAR"
  }

  # Enable network policy enforcement (Calico)
  network_policy {
    enabled  = true
    provider = "CALICO"
  }

  addons_config {
    network_policy_config {
      disabled = false
    }
    http_load_balancing {
      disabled = false
    }
    horizontal_pod_autoscaling {
      disabled = false
    }
  }

  # Cost control: deletion protection off so terraform destroy works on Day 9
  deletion_protection = false

  resource_labels = {
    environment = var.environment
    managed_by  = "terraform"
    project     = "observashop"
  }
}

# Separately managed node pool — best practice
resource "google_container_node_pool" "primary" {
  project    = var.project_id
  name       = "primary"
  location   = var.region
  cluster    = google_container_cluster.this.name
  node_count = var.node_count

  node_config {
    machine_type    = var.machine_type
    disk_size_gb    = var.disk_size_gb
    disk_type       = "pd-standard"
    image_type      = "COS_CONTAINERD"
    service_account = google_service_account.gke_nodes.email

    oauth_scopes = [
      "https://www.googleapis.com/auth/cloud-platform"
    ]

    # Shielded nodes — security baseline
    shielded_instance_config {
      enable_secure_boot          = true
      enable_integrity_monitoring = true
    }

    # Workload Identity metadata mode
    workload_metadata_config {
      mode = "GKE_METADATA"
    }

    labels = {
      environment = var.environment
      managed_by  = "terraform"
    }

    tags = ["gke-node", "observashop-${var.environment}"]
  }

  management {
    auto_repair  = true
    auto_upgrade = true
  }

  upgrade_settings {
    max_surge       = 1
    max_unavailable = 0
  }
}
