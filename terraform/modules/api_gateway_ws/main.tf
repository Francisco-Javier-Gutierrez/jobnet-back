data "aws_region" "current" {}

resource "aws_apigatewayv2_api" "ws_api" {
  name                       = "jobnet-ws-api-${var.environment}"
  protocol_type              = "WEBSOCKET"
  route_selection_expression = "$request.body.action"
}

# Authorizer
resource "aws_apigatewayv2_authorizer" "lambda_auth" {
  api_id           = aws_apigatewayv2_api.ws_api.id
  authorizer_type  = "REQUEST"
  authorizer_uri   = "arn:aws:apigateway:${data.aws_region.current.name}:lambda:path/2015-03-31/functions/${var.lambda_arn_wsAuthorizer}/invocations"
  name             = "ws-lambda-authorizer"
  identity_sources = ["route.request.querystring.token"]
}

# $connect
resource "aws_apigatewayv2_integration" "connect" {
  api_id           = aws_apigatewayv2_api.ws_api.id
  integration_type = "AWS_PROXY"
  integration_uri  = "arn:aws:apigateway:${data.aws_region.current.name}:lambda:path/2015-03-31/functions/${var.lambda_arn_wsConnect}/invocations"
}

resource "aws_apigatewayv2_route" "connect" {
  api_id             = aws_apigatewayv2_api.ws_api.id
  route_key          = "$connect"
  target             = "integrations/${aws_apigatewayv2_integration.connect.id}"
  authorization_type = "CUSTOM"
  authorizer_id      = aws_apigatewayv2_authorizer.lambda_auth.id
}

# $disconnect
resource "aws_apigatewayv2_integration" "disconnect" {
  api_id           = aws_apigatewayv2_api.ws_api.id
  integration_type = "AWS_PROXY"
  integration_uri  = "arn:aws:apigateway:${data.aws_region.current.name}:lambda:path/2015-03-31/functions/${var.lambda_arn_wsDisconnect}/invocations"
}

resource "aws_apigatewayv2_route" "disconnect" {
  api_id    = aws_apigatewayv2_api.ws_api.id
  route_key = "$disconnect"
  target    = "integrations/${aws_apigatewayv2_integration.disconnect.id}"
}

# $default
resource "aws_apigatewayv2_integration" "default" {
  api_id           = aws_apigatewayv2_api.ws_api.id
  integration_type = "AWS_PROXY"
  integration_uri  = "arn:aws:apigateway:${data.aws_region.current.name}:lambda:path/2015-03-31/functions/${var.lambda_arn_wsDefault}/invocations"
}

resource "aws_apigatewayv2_route" "default" {
  api_id    = aws_apigatewayv2_api.ws_api.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.default.id}"
}

# Stage & Deployment
resource "aws_apigatewayv2_deployment" "ws_deployment" {
  api_id = aws_apigatewayv2_api.ws_api.id

  depends_on = [
    aws_apigatewayv2_route.connect,
    aws_apigatewayv2_route.disconnect,
    aws_apigatewayv2_route.default
  ]

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_apigatewayv2_stage" "ws_stage" {
  api_id        = aws_apigatewayv2_api.ws_api.id
  name          = var.environment
  deployment_id = aws_apigatewayv2_deployment.ws_deployment.id
}

# Lambda Permissions
resource "aws_lambda_permission" "apigw_wsAuthorizer" {
  statement_id  = "AllowExecutionFromAPIGatewayAuthorizer"
  action        = "lambda:InvokeFunction"
  function_name = var.lambda_arn_wsAuthorizer
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.ws_api.execution_arn}/authorizers/${aws_apigatewayv2_authorizer.lambda_auth.id}"
}

resource "aws_lambda_permission" "apigw_wsConnect" {
  statement_id  = "AllowExecutionFromAPIGatewayConnect"
  action        = "lambda:InvokeFunction"
  function_name = var.lambda_arn_wsConnect
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.ws_api.execution_arn}/*/*"
}

resource "aws_lambda_permission" "apigw_wsDisconnect" {
  statement_id  = "AllowExecutionFromAPIGatewayDisconnect"
  action        = "lambda:InvokeFunction"
  function_name = var.lambda_arn_wsDisconnect
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.ws_api.execution_arn}/*/*"
}

resource "aws_lambda_permission" "apigw_wsDefault" {
  statement_id  = "AllowExecutionFromAPIGatewayDefault"
  action        = "lambda:InvokeFunction"
  function_name = var.lambda_arn_wsDefault
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.ws_api.execution_arn}/*/*"
}
