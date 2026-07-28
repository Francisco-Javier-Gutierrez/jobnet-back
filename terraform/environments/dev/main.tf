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
  #   bucket         = "jobnet-terraform-state-dev"
  #   key            = "dev/terraform.tfstate"
  #   region         = "us-east-1"
  #   dynamodb_table = "jobnet-terraform-locks"
  #   encrypt        = true
  # }
}

provider "aws" {
  region = "us-east-1"

  ignore_tags {
    keys = ["Environment", "ManagedBy", "Project"]
  }
}

module "infrastructure" {
  source      = "../../modules/infrastructure"
  environment = "dev"
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
