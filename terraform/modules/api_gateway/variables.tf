variable "environment" {
  type = string
}

variable "cognito_user_pool_arn" {
  type = string
}

variable "lambda_arn_getJobs" {
  type = string
}

variable "lambda_arn_createJob" {
  type = string
}

variable "lambda_arn_getUploadPresignedUrl" {
  type = string
}

variable "lambda_arn_sendNotificationEmail" {
  type = string
}
