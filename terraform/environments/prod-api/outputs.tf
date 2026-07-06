output "api_gateway_url" {
  value = module.api_gateway.api_gateway_url
}

output "ws_api_url" {
  value = module.api_gateway_ws.ws_api_url
}
