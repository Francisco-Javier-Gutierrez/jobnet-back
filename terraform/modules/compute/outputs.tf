output "http_api_id" {
  description = "ID of the HTTP API Gateway"
  value       = aws_apigatewayv2_api.http_api.id
}

output "http_api_url" {
  description = "Base invoke URL of the HTTP API Gateway"
  value       = aws_apigatewayv2_api.http_api.api_endpoint
}

output "ws_api_id" {
  description = "ID of the WebSocket API Gateway"
  value       = aws_apigatewayv2_api.ws_api.id
}

output "ws_api_url" {
  description = "WSS URL of the WebSocket API Gateway"
  value       = "${aws_apigatewayv2_api.ws_api.api_endpoint}/${var.environment}"
}

output "lambda_api_arn" {
  description = "ARN of the HTTP Express API Lambda"
  value       = aws_lambda_function.api.arn
}

output "lambda_ws_arn" {
  description = "ARN of the WebSocket router Lambda"
  value       = aws_lambda_function.ws.arn
}

output "lambda_post_confirmation_arn" {
  description = "ARN of the Cognito PostConfirmation Lambda"
  value       = aws_lambda_function.post_confirmation.arn
}

output "lambda_suspension_expiry_arn" {
  description = "ARN of the DynamoDB stream suspension expiry Lambda"
  value       = aws_lambda_function.suspension_expiry.arn
}
