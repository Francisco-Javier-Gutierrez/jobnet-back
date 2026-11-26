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

variable "deepseek_api_key" {
  type        = string
  default     = ""
  sensitive   = true
  description = "DeepSeek API Key"
}

variable "deepseek_api_url" {
  type        = string
  default     = "https://api.deepseek.com/chat/completions"
  description = "DeepSeek API URL"
}

variable "gemini_api_key" {
  type        = string
  default     = ""
  sensitive   = true
  description = "Gemini API Key"
}

variable "gemini_api_url" {
  type        = string
  default     = "https://generativelanguage.googleapis.com/v1beta/models"
  description = "Gemini API URL"
}

variable "ai_provider" {
  type        = string
  default     = "deepseek"
  description = "Proveedor global de IA"
}

variable "ai_moderation_provider" {
  type        = string
  default     = "deepseek"
  description = "Proveedor de moderación con IA"
}

variable "ai_moderation_model" {
  type        = string
  default     = "deepseek-chat"
  description = "Modelo para moderación con IA"
}

variable "ai_reasoning_provider" {
  type        = string
  default     = "deepseek"
  description = "Proveedor de razonamiento y ATS con IA"
}

variable "ai_reasoning_model" {
  type        = string
  default     = "deepseek-chat"
  description = "Modelo para razonamiento y ATS con IA"
}

module "infrastructure" {
  source               = "../../modules/infrastructure"
  environment          = "prod"
  google_client_id     = var.google_client_id
  google_client_secret = var.google_client_secret
}

module "compute" {
  source = "../../modules/compute"

  environment                 = "prod"
  aws_region                  = "us-east-1"
  dynamodb_table_name         = module.infrastructure.dynamodb_table_name
  dynamodb_table_arn          = module.infrastructure.dynamodb_table_arn
  dynamodb_table_stream_arn   = module.infrastructure.dynamodb_table_stream_arn
  s3_upload_bucket_name       = module.infrastructure.s3_upload_bucket
  s3_upload_bucket_arn        = module.infrastructure.s3_upload_bucket_arn
  cognito_user_pool_id        = module.infrastructure.user_pool_id
  cognito_user_pool_arn       = module.infrastructure.user_pool_arn
  cognito_user_pool_client_id = module.infrastructure.user_pool_client_id
  dist_zips_path              = abspath("${path.root}/../../../dist/zips")

  deepseek_api_key            = var.deepseek_api_key
  deepseek_api_url            = var.deepseek_api_url
  gemini_api_key              = var.gemini_api_key
  gemini_api_url              = var.gemini_api_url
  ai_provider                 = var.ai_provider
  ai_moderation_provider      = var.ai_moderation_provider
  ai_moderation_model         = var.ai_moderation_model
  ai_reasoning_provider       = var.ai_reasoning_provider
  ai_reasoning_model          = var.ai_reasoning_model
}

output "user_pool_id" {
  value = module.infrastructure.user_pool_id
}

output "user_pool_arn" {
  value = module.infrastructure.user_pool_arn
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

output "dynamodb_table_arn" {
  value = module.infrastructure.dynamodb_table_arn
}

output "dynamodb_table_stream_arn" {
  value = module.infrastructure.dynamodb_table_stream_arn
}

output "s3_upload_bucket" {
  value = module.infrastructure.s3_upload_bucket
}

output "s3_upload_bucket_arn" {
  value = module.infrastructure.s3_upload_bucket_arn
}

output "opensearch_endpoint" {
  value = module.infrastructure.opensearch_endpoint
}

output "http_api_id" {
  value = module.compute.http_api_id
}

output "http_api_url" {
  value = module.compute.http_api_url
}

output "ws_api_id" {
  value = module.compute.ws_api_id
}

output "ws_api_url" {
  value = module.compute.ws_api_url
}

output "lambda_api_arn" {
  value = module.compute.lambda_api_arn
}

output "lambda_ws_arn" {
  value = module.compute.lambda_ws_arn
}

output "lambda_post_confirmation_arn" {
  value = module.compute.lambda_post_confirmation_arn
}

output "lambda_suspension_expiry_arn" {
  value = module.compute.lambda_suspension_expiry_arn
}
