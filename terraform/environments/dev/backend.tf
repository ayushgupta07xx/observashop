terraform {
  backend "gcs" {
    bucket = "observashop-dev-202604-tfstate"
    prefix = "environments/dev"
  }
}
