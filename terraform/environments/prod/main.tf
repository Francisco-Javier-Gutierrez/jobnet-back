terraform {
  required_version = ">= 1.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  backend "s3" {
    bucket  = "jobnet-terraform-state-prod-293626296338"
    key     = "back/prod/terraform.tfstate"
    region  = "us-east-1"
    encrypt = true
  }
}

provider "aws" {
  region  = "us-east-1"

  ignore_tags {
    keys = ["Environment", "ManagedBy", "Project"]
  }
}

variable "google_client_id" {
  type        = string
  default     = "548876938666-r0a6ir9ch13pe2t8i1g6p028c68h4vjc.apps.googleusercontent.com"
  description = "Client ID de OAuth 2.0 de Google Cloud Console"
}

variable "google_client_secret" {
  type        = string
  default     = "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"
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
