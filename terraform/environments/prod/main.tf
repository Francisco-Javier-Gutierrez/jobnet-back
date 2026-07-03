terraform {
  required_version = ">= 1.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = "us-east-1"
}

module "infrastructure" {
  source      = "../../modules/infrastructure"
  environment = "prod"
}

output "user_pool_id" {
  value = module.infrastructure.user_pool_id
}

output "user_pool_client_id" {
  value = module.infrastructure.user_pool_client_id
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
