terraform {
  required_version = ">= 1.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # Remote backend template (terraform-architect standard)
  # backend "s3" {
  #   bucket         = "jobnet-terraform-state-prod"
  #   key            = "prod/terraform.tfstate"
  #   region         = "us-east-1"
  #   dynamodb_table = "jobnet-terraform-locks"
  #   encrypt        = true
  # }
}

provider "aws" {
  region  = "us-east-1"
  profile = "terra-profile"

  ignore_tags {
    keys = ["Environment", "ManagedBy", "Project"]
  }
}

variable "google_client_id" {
  type        = string
  default     = ""
  description = "Client ID de OAuth 2.0 de Google Cloud Console"
}

variable "google_client_secret" {
  type        = string
  default     = ""
  sensitive   = true
  description = "Client Secret de OAuth 2.0 de Google Cloud Console"
}

module "infrastructure" {
  source               = "../../modules/infrastructure"
  environment          = "prod"
  google_client_id     = var.google_client_id
  google_client_secret = var.google_client_secret
}

output "user_pool_id" {
  value = module.infrastructure.user_pool_id
}

output "user_pool_client_id" {
  value = module.infrastructure.user_pool_client_id
}

output "cognito_domain" {
  value = module.infrastructure.cognito_domain
}

output "google_authorized_redirect_uri" {
  value = module.infrastructure.google_authorized_redirect_uri
}

output "dynamodb_table_name" {
  value = module.infrastructure.dynamodb_table_name
}

output "s3_upload_bucket" {
  value = module.infrastructure.s3_upload_bucket
}

output "opensearch_endpoint" {
  value = module.infrastructure.opensearch_endpoint
}
