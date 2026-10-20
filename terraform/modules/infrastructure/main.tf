data "aws_caller_identity" "current" {}



resource "aws_cognito_user_pool" "pool" {
  name = "jobnet-user-pool-${var.environment}"

  password_policy {
    minimum_length    = 8
    require_lowercase = true
    require_numbers   = true
    require_symbols   = true
    require_uppercase = true
  }

  schema {
    attribute_data_type      = "String"
    developer_only_attribute = false
    mutable                  = true
    name                     = "email"
    required                 = true

    string_attribute_constraints {
      min_length = 7
      max_length = 256
    }
  }

  schema {
    attribute_data_type      = "String"
    developer_only_attribute = false
    mutable                  = true
    name                     = "role"
    required                 = false

    string_attribute_constraints {
      min_length = 1
      max_length = 256
    }
  }

  schema {
    attribute_data_type      = "String"
    developer_only_attribute = false
    mutable                  = true
    name                     = "tax_id"
    required                 = false

    string_attribute_constraints {
      min_length = 1
      max_length = 256
    }
  }

  mfa_configuration = "OPTIONAL"

  software_token_mfa_configuration {
    enabled = true
  }

  auto_verified_attributes = ["email"]

  email_configuration {
    email_sending_account = "DEVELOPER"
    from_email_address    = "contacto@franciscojgh.com"
    source_arn            = "arn:aws:ses:us-east-1:${data.aws_caller_identity.current.account_id}:identity/franciscojgh.com"
  }

  # The PostConfirmation trigger is managed by Serverless Framework,
  # and existing schema attributes cannot be deleted via AWS API,
  # so we ignore lambda_config and schema changes.
  lifecycle {
    ignore_changes = [lambda_config, schema]
  }
}

resource "aws_cognito_resource_server" "resource_server" {
  identifier   = "jobnet"
  name         = "JobNet Resource Server"
  user_pool_id = aws_cognito_user_pool.pool.id

  scope {
    scope_name        = "admin"
    scope_description = "Admin access to JobNet resources"
  }

  scope {
    scope_name        = "moderator"
    scope_description = "Moderator access to JobNet resources"
  }

  scope {
    scope_name        = "organization"
    scope_description = "Organization access to JobNet resources"
  }

  scope {
    scope_name        = "candidate"
    scope_description = "Candidate access to JobNet resources"
  }
}

resource "aws_cognito_user_pool_domain" "domain" {
  domain       = var.cognito_domain_prefix != "" ? "${var.cognito_domain_prefix}-${var.environment}" : "jobnet-auth-${var.environment}"
  user_pool_id = aws_cognito_user_pool.pool.id
}

resource "aws_cognito_identity_provider" "google" {
  count         = var.google_client_id != "" ? 1 : 0
  user_pool_id  = aws_cognito_user_pool.pool.id
  provider_name = "Google"
  provider_type = "Google"

  provider_details = {
    client_id        = var.google_client_id
    client_secret    = var.google_client_secret
    authorize_scopes = "email openid profile"
  }

  attribute_mapping = {
    email    = "email"
    name     = "name"
    username = "sub"
  }
}

resource "aws_cognito_user_pool_client" "client" {
  name         = "jobnet-app-client-${var.environment}"
  user_pool_id = aws_cognito_user_pool.pool.id

  generate_secret                      = false
  explicit_auth_flows                  = ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH", "ALLOW_USER_SRP_AUTH"]
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code", "implicit"]
  allowed_oauth_scopes = [
    "email",
    "openid",
    "profile",
    "jobnet/admin",
    "jobnet/moderator",
    "jobnet/organization",
    "jobnet/candidate"
  ]
  callback_urls = [
    "http://localhost:3000/api/auth/callback/cognito",
    "http://localhost:3000",
    "https://jobnet.franciscojgh.com/api/auth/callback/cognito",
    "https://jobnet.franciscojgh.com",
    "https://dsty3j5u0b31g.cloudfront.net/api/auth/callback/cognito",
    "https://dsty3j5u0b31g.cloudfront.net"
  ]
  logout_urls = [
    "http://localhost:3000",
    "https://jobnet.franciscojgh.com",
    "https://dsty3j5u0b31g.cloudfront.net"
  ]
  supported_identity_providers = var.google_client_id != "" ? ["COGNITO", "Google"] : ["COGNITO"]
  depends_on = [
    aws_cognito_resource_server.resource_server,
    aws_cognito_identity_provider.google,
    aws_cognito_user_pool_domain.domain
  ]
}

resource "aws_dynamodb_table" "jobs" {
  name             = "jobnet-jobs-${var.environment}"
  billing_mode     = "PAY_PER_REQUEST"
  hash_key         = "PK"
  range_key        = "SK"
  stream_enabled   = true
  stream_view_type = "NEW_AND_OLD_IMAGES"

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  attribute {
    name = "PK"
    type = "S"
  }

  attribute {
    name = "SK"
    type = "S"
  }

  attribute {
    name = "GSI1PK"
    type = "S"
  }

  attribute {
    name = "GSI1SK"
    type = "S"
  }

  global_secondary_index {
    name            = "GSI1"
    hash_key        = "GSI1PK"
    range_key       = "GSI1SK"
    projection_type = "ALL"
  }
}

resource "aws_s3_bucket" "uploads" {
  bucket = "jobnet-uploads-${var.environment}"
}

resource "aws_s3_bucket_public_access_block" "uploads_public" {
  bucket                  = aws_s3_bucket.uploads.id
  block_public_acls       = false
  block_public_policy     = false
  ignore_public_acls      = false
  restrict_public_buckets = false
}

resource "aws_s3_bucket_cors_configuration" "uploads_cors" {
  bucket = aws_s3_bucket.uploads.id

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["GET", "PUT", "POST", "DELETE", "HEAD"]
    allowed_origins = ["*"]
    expose_headers  = ["ETag"]
    max_age_seconds = 3000
  }
}

resource "aws_s3_bucket_policy" "uploads_policy" {
  bucket     = aws_s3_bucket.uploads.id
  depends_on = [aws_s3_bucket_public_access_block.uploads_public]
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "PublicRead"
        Effect    = "Allow"
        Principal = "*"
        Action    = "s3:GetObject"
        Resource  = "${aws_s3_bucket.uploads.arn}/*"
      }
    ]
  })
}

resource "aws_opensearch_domain" "search" {
  count          = var.enable_opensearch ? 1 : 0
  domain_name    = "jobnet-search-${var.environment}"
  engine_version = "OpenSearch_2.11"

  cluster_config {
    instance_type = "t3.small.search"
  }

  ebs_options {
    ebs_enabled = true
    volume_size = 10
  }

  access_policies = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          AWS = "*"
        }
        Action   = "es:*"
        Resource = "arn:aws:es:us-east-1:${data.aws_caller_identity.current.account_id}:domain/jobnet-search-${var.environment}/*"
        Condition = {
          StringEquals = {
            "aws:PrincipalAccount" = data.aws_caller_identity.current.account_id
          }
        }
      }
    ]
  })
}
