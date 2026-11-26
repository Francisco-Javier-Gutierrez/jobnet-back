terraform {
  required_version = ">= 1.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

# ==========================================
# IAM ROLE & POLICIES FOR LAMBDAS
# ==========================================
resource "aws_iam_role" "lambda_exec" {
  name = "jobnet-lambda-role-${var.environment}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_basic" {
  role       = aws_iam_role.lambda_exec.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_policy" "lambda_custom" {
  name = "jobnet-lambda-policy-${var.environment}"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "dynamodb:PutItem",
          "dynamodb:GetItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:Query",
          "dynamodb:Scan",
          "dynamodb:BatchGetItem",
          "dynamodb:BatchWriteItem"
        ]
        Resource = [
          var.dynamodb_table_arn,
          "${var.dynamodb_table_arn}/index/*"
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "dynamodb:GetRecords",
          "dynamodb:GetShardIterator",
          "dynamodb:DescribeStream",
          "dynamodb:ListStreams"
        ]
        Resource = [
          "${var.dynamodb_table_arn}/stream/*",
          var.dynamodb_table_stream_arn
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "s3:PutObject",
          "s3:GetObject",
          "s3:PutObjectAcl",
          "s3:DeleteObject"
        ]
        Resource = "${var.s3_upload_bucket_arn}/*"
      },
      {
        Effect = "Allow"
        Action = [
          "ses:SendEmail",
          "ses:SendRawEmail"
        ]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "execute-api:ManageConnections"
        ]
        Resource = "arn:aws:execute-api:${var.aws_region}:*:*/*"
      },
      {
        Effect = "Allow"
        Action = [
          "cognito-idp:AdminGetUser",
          "cognito-idp:AdminUpdateUserAttributes",
          "cognito-idp:ListUsers"
        ]
        Resource = var.cognito_user_pool_arn
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_custom" {
  role       = aws_iam_role.lambda_exec.name
  policy_arn = aws_iam_policy.lambda_custom.arn
}

# ==========================================
# 1. EXPRESS HTTP API LAMBDA
# ==========================================
resource "aws_lambda_function" "api" {
  function_name    = "jobnet-api-${var.environment}"
  filename         = "${var.dist_zips_path}/api.zip"
  source_code_hash = filebase64sha256("${var.dist_zips_path}/api.zip")
  role             = aws_iam_role.lambda_exec.arn
  handler          = "index.handler"
  runtime          = "nodejs20.x"
  architectures    = ["arm64"]
  timeout          = 30
  memory_size      = 1024

  environment {
    variables = {
      NODE_ENV             = "production"
      DYNAMODB_TABLE       = var.dynamodb_table_name
      S3_UPLOAD_BUCKET     = var.s3_upload_bucket_name
      COGNITO_USER_POOL_ID = var.cognito_user_pool_id
      COGNITO_CLIENT_ID    = var.cognito_user_pool_client_id
      VAPID_PUBLIC_KEY     = var.vapid_public_key
      VAPID_PRIVATE_KEY    = var.vapid_private_key
      VAPID_SUBJECT          = var.vapid_subject
      GEMINI_API_KEY         = var.gemini_api_key
      GEMINI_API_URL         = var.gemini_api_url
      DEEPSEEK_API_KEY       = var.deepseek_api_key
      DEEPSEEK_API_URL       = var.deepseek_api_url
      AI_PROVIDER            = var.ai_provider
      AI_MODERATION_PROVIDER = var.ai_moderation_provider
      AI_MODERATION_MODEL    = var.ai_moderation_model
      AI_REASONING_PROVIDER  = var.ai_reasoning_provider
      AI_REASONING_MODEL     = var.ai_reasoning_model
      WS_API_ID              = aws_apigatewayv2_api.ws_api.id
    }
  }
}

# ==========================================
# 2. WEBSOCKET ROUTER LAMBDA
# ==========================================
resource "aws_lambda_function" "ws" {
  function_name    = "jobnet-ws-${var.environment}"
  filename         = "${var.dist_zips_path}/ws.zip"
  source_code_hash = filebase64sha256("${var.dist_zips_path}/ws.zip")
  role             = aws_iam_role.lambda_exec.arn
  handler          = "index.handler"
  runtime          = "nodejs20.x"
  architectures    = ["arm64"]
  timeout          = 30
  memory_size      = 512

  environment {
    variables = {
      NODE_ENV             = "production"
      DYNAMODB_TABLE       = var.dynamodb_table_name
      S3_UPLOAD_BUCKET     = var.s3_upload_bucket_name
      COGNITO_USER_POOL_ID = var.cognito_user_pool_id
      COGNITO_CLIENT_ID    = var.cognito_user_pool_client_id
      VAPID_PUBLIC_KEY     = var.vapid_public_key
      VAPID_PRIVATE_KEY    = var.vapid_private_key
      VAPID_SUBJECT        = var.vapid_subject
      WS_API_ID            = aws_apigatewayv2_api.ws_api.id
    }
  }
}

# ==========================================
# 3. WEBSOCKET AUTHORIZER LAMBDA
# ==========================================
resource "aws_lambda_function" "ws_authorizer" {
  function_name    = "jobnet-ws-authorizer-${var.environment}"
  filename         = "${var.dist_zips_path}/wsAuthorizer.zip"
  source_code_hash = filebase64sha256("${var.dist_zips_path}/wsAuthorizer.zip")
  role             = aws_iam_role.lambda_exec.arn
  handler          = "index.handler"
  runtime          = "nodejs20.x"
  architectures    = ["arm64"]
  timeout          = 10
  memory_size      = 256

  environment {
    variables = {
      NODE_ENV             = "production"
      DYNAMODB_TABLE       = var.dynamodb_table_name
      COGNITO_USER_POOL_ID = var.cognito_user_pool_id
      COGNITO_CLIENT_ID    = var.cognito_user_pool_client_id
    }
  }
}

# ==========================================
# 4. COGNITO POST CONFIRMATION LAMBDA
# ==========================================
resource "aws_lambda_function" "post_confirmation" {
  function_name    = "jobnet-post-confirmation-${var.environment}"
  filename         = "${var.dist_zips_path}/postConfirmation.zip"
  source_code_hash = filebase64sha256("${var.dist_zips_path}/postConfirmation.zip")
  role             = aws_iam_role.lambda_exec.arn
  handler          = "index.handler"
  runtime          = "nodejs20.x"
  architectures    = ["arm64"]
  timeout          = 30
  memory_size      = 512

  environment {
    variables = {
      NODE_ENV             = "production"
      DYNAMODB_TABLE       = var.dynamodb_table_name
      COGNITO_USER_POOL_ID = var.cognito_user_pool_id
    }
  }
}

# ==========================================
# 5. DYNAMODB STREAM SUSPENSION EXPIRY LAMBDA
# ==========================================
resource "aws_lambda_function" "suspension_expiry" {
  function_name    = "jobnet-suspension-expiry-${var.environment}"
  filename         = "${var.dist_zips_path}/suspensionExpiry.zip"
  source_code_hash = filebase64sha256("${var.dist_zips_path}/suspensionExpiry.zip")
  role             = aws_iam_role.lambda_exec.arn
  handler          = "index.handler"
  runtime          = "nodejs20.x"
  architectures    = ["arm64"]
  timeout          = 30
  memory_size      = 512

  environment {
    variables = {
      NODE_ENV       = "production"
      DYNAMODB_TABLE = var.dynamodb_table_name
    }
  }
}

# DynamoDB Stream Event Source Mapping for Suspension Expiry
resource "aws_lambda_event_source_mapping" "suspension_stream" {
  event_source_arn  = var.dynamodb_table_stream_arn
  function_name     = aws_lambda_function.suspension_expiry.arn
  starting_position = "LATEST"
  batch_size        = 100

  filter_criteria {
    filter {
      pattern = jsonencode({
        eventName = ["REMOVE"]
      })
    }
  }
}

# Permission for Cognito to invoke post_confirmation Lambda
resource "aws_lambda_permission" "cognito_post_confirmation" {
  statement_id  = "AllowExecutionFromCognitoUserPool"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.post_confirmation.function_name
  principal     = "cognito-idp.amazonaws.com"
  source_arn    = var.cognito_user_pool_arn
}

# ==========================================
# HTTP API GATEWAY V2
# ==========================================
resource "aws_apigatewayv2_api" "http_api" {
  name          = "jobnet-http-api-${var.environment}"
  protocol_type = "HTTP"

  cors_configuration {
    allow_origins = [
      "https://jobnet.franciscojgh.com",
      "https://dsty3j5u0b31g.cloudfront.net",
      "http://localhost:3000",
      "http://127.0.0.1:3000"
    ]
    allow_methods = ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"]
    allow_headers = [
      "Content-Type",
      "content-type",
      "Authorization",
      "authorization",
      "X-Amz-Date",
      "x-amz-date",
      "X-Api-Key",
      "x-api-key",
      "X-Amz-Security-Token",
      "x-amz-security-token",
      "X-Amz-User-Agent",
      "x-amz-user-agent",
      "x-user-id",
      "x-user-role",
      "x-user-email",
      "x-user-type"
    ]
    allow_credentials = true
    max_age           = 3600
  }
}

resource "aws_apigatewayv2_integration" "http_api" {
  api_id                 = aws_apigatewayv2_api.http_api.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.api.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "default" {
  api_id    = aws_apigatewayv2_api.http_api.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.http_api.id}"
}

resource "aws_apigatewayv2_route" "proxy" {
  api_id    = aws_apigatewayv2_api.http_api.id
  route_key = "ANY /{proxy+}"
  target    = "integrations/${aws_apigatewayv2_integration.http_api.id}"
}

resource "aws_apigatewayv2_stage" "http_stage" {
  api_id      = aws_apigatewayv2_api.http_api.id
  name        = "$default"
  auto_deploy = true
}

resource "aws_lambda_permission" "http_api" {
  statement_id  = "AllowExecutionFromAPIGatewayHTTP"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http_api.execution_arn}/*/*"
}

# ==========================================
# WEBSOCKET API GATEWAY V2
# ==========================================
resource "aws_apigatewayv2_api" "ws_api" {
  name                       = "jobnet-ws-api-${var.environment}"
  protocol_type              = "WEBSOCKET"
  route_selection_expression = "$request.body.action"
}

resource "aws_apigatewayv2_authorizer" "ws_auth" {
  api_id           = aws_apigatewayv2_api.ws_api.id
  authorizer_type  = "REQUEST"
  authorizer_uri   = "arn:aws:apigateway:${var.aws_region}:lambda:path/2015-03-31/functions/${aws_lambda_function.ws_authorizer.arn}/invocations"
  name             = "ws-lambda-authorizer"
  identity_sources = ["route.request.querystring.token"]
}

resource "aws_apigatewayv2_integration" "ws_integration" {
  api_id           = aws_apigatewayv2_api.ws_api.id
  integration_type = "AWS_PROXY"
  integration_uri  = "arn:aws:apigateway:${var.aws_region}:lambda:path/2015-03-31/functions/${aws_lambda_function.ws.arn}/invocations"
}

resource "aws_apigatewayv2_route" "ws_connect" {
  api_id             = aws_apigatewayv2_api.ws_api.id
  route_key          = "$connect"
  target             = "integrations/${aws_apigatewayv2_integration.ws_integration.id}"
  authorization_type = "CUSTOM"
  authorizer_id      = aws_apigatewayv2_authorizer.ws_auth.id
}

resource "aws_apigatewayv2_route" "ws_disconnect" {
  api_id    = aws_apigatewayv2_api.ws_api.id
  route_key = "$disconnect"
  target    = "integrations/${aws_apigatewayv2_integration.ws_integration.id}"
}

resource "aws_apigatewayv2_route" "ws_default" {
  api_id    = aws_apigatewayv2_api.ws_api.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.ws_integration.id}"
}

resource "aws_apigatewayv2_route" "ws_send_message" {
  api_id    = aws_apigatewayv2_api.ws_api.id
  route_key = "sendMessage"
  target    = "integrations/${aws_apigatewayv2_integration.ws_integration.id}"
}

resource "aws_apigatewayv2_stage" "ws_stage" {
  api_id      = aws_apigatewayv2_api.ws_api.id
  name        = var.environment
  auto_deploy = true
}

resource "aws_lambda_permission" "ws_authorizer" {
  statement_id  = "AllowExecutionFromAPIGatewayAuthorizer"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.ws_authorizer.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.ws_api.execution_arn}/authorizers/${aws_apigatewayv2_authorizer.ws_auth.id}"
}

resource "aws_lambda_permission" "ws_invoke" {
  statement_id  = "AllowExecutionFromAPIGatewayWS"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.ws.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.ws_api.execution_arn}/*/*"
}
