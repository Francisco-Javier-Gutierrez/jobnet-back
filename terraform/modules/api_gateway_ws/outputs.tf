output "ws_api_url" {
  value = aws_apigatewayv2_stage.ws_stage.invoke_url
}
