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

module "api_gateway" {
  source = "../../modules/api_gateway"
  
  environment = "prod"
  cognito_user_pool_arn = var.cognito_user_pool_arn
  
  lambda_arn_getJobs               = var.lambda_arn_getJobs
  lambda_arn_createJob             = var.lambda_arn_createJob
  lambda_arn_getUploadPresignedUrl = var.lambda_arn_getUploadPresignedUrl
  lambda_arn_sendNotificationEmail = var.lambda_arn_sendNotificationEmail
}

module "api_gateway_ws" {
  source = "../../modules/api_gateway_ws"
  
  environment             = "prod"
  lambda_arn_wsAuthorizer = var.lambda_arn_wsAuthorizer
  lambda_arn_wsConnect    = var.lambda_arn_wsConnect
  lambda_arn_wsDisconnect = var.lambda_arn_wsDisconnect
  lambda_arn_wsDefault    = var.lambda_arn_wsDefault
}
