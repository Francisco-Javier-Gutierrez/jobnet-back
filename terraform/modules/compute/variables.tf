variable "environment" {
  type        = string
  description = "Deployment environment (e.g. prod)"
  default     = "prod"
}

variable "aws_region" {
  type        = string
  description = "AWS region"
  default     = "us-east-1"
}

variable "dynamodb_table_name" {
  type        = string
  description = "Name of the DynamoDB table"
}

variable "dynamodb_table_arn" {
  type        = string
  description = "ARN of the DynamoDB table"
}

variable "dynamodb_table_stream_arn" {
  type        = string
  description = "ARN of the DynamoDB stream"
}

variable "s3_upload_bucket_name" {
  type        = string
  description = "Name of the S3 uploads bucket"
}

variable "s3_upload_bucket_arn" {
  type        = string
  description = "ARN of the S3 uploads bucket"
}

variable "cognito_user_pool_id" {
  type        = string
  description = "Cognito User Pool ID"
}

variable "cognito_user_pool_arn" {
  type        = string
  description = "Cognito User Pool ARN"
}

variable "cognito_user_pool_client_id" {
  type        = string
  description = "Cognito User Pool Client ID"
}

variable "vapid_public_key" {
  type        = string
  description = "VAPID Public Key for Web Push"
  default     = "BOIrktuQCHHiOWcKICA7YEwdKJf8WNYCmBS_PI338wnaB9VqXPQfCRwTN5NLYokujXBp5pdD83av6DACG2rAYok"
}

variable "vapid_private_key" {
  type        = string
  description = "VAPID Private Key for Web Push"
  sensitive   = true
  default     = "oJXO_P5wuj45JaC8taPC1E3pPR8Hu1zi_kAiv5yAaNg"
}

variable "vapid_subject" {
  type        = string
  description = "VAPID Subject mailto"
  default     = "mailto:contacto@franciscojgh.com"
}

variable "gemini_api_key" {
  type        = string
  description = "Gemini API Key"
  default     = ""
  sensitive   = true
}

variable "gemini_api_url" {
  type        = string
  description = "Gemini API URL"
  default     = "https://generativelanguage.googleapis.com/v1beta/models"
}

variable "deepseek_api_key" {
  type        = string
  description = "DeepSeek API Key"
  default     = ""
  sensitive   = true
}

variable "deepseek_api_url" {
  type        = string
  description = "DeepSeek API URL"
  default     = "https://api.deepseek.com/chat/completions"
}

variable "ai_provider" {
  type        = string
  description = "Proveedor global de IA"
  default     = "deepseek"
}

variable "ai_moderation_provider" {
  type        = string
  description = "Proveedor de moderación con IA"
  default     = "deepseek"
}

variable "ai_moderation_model" {
  type        = string
  description = "Modelo para moderación con IA"
  default     = "deepseek-chat"
}

variable "ai_reasoning_provider" {
  type        = string
  description = "Proveedor de razonamiento y ATS con IA"
  default     = "deepseek"
}

variable "ai_reasoning_model" {
  type        = string
  description = "Modelo para razonamiento y ATS con IA"
  default     = "deepseek-chat"
}

variable "dist_zips_path" {
  type        = string
  description = "Absolute or relative path to the directory containing lambda zip packages"
  default     = "../../dist/zips"
}
