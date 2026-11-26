output "user_pool_id" {
  value = aws_cognito_user_pool.pool.id
}

output "user_pool_arn" {
  value = aws_cognito_user_pool.pool.arn
}

output "user_pool_client_id" {
  value = aws_cognito_user_pool_client.client.id
}

output "dynamodb_table_name" {
  value = aws_dynamodb_table.jobs.name
}

output "dynamodb_table_arn" {
  value = aws_dynamodb_table.jobs.arn
}

output "s3_upload_bucket" {
  value = aws_s3_bucket.uploads.bucket
}

output "s3_upload_bucket_arn" {
  value = aws_s3_bucket.uploads.arn
}

output "opensearch_endpoint" {
  value = try(aws_opensearch_domain.search[0].endpoint, "")
}

output "dynamodb_table_stream_arn" {
  value = aws_dynamodb_table.jobs.stream_arn
}

output "cognito_domain" {
  value       = aws_cognito_user_pool_domain.domain.domain
  description = "Dominio de Cognito para OAuth 2.0 y federación Google"
}

output "google_authorized_redirect_uri" {
  value       = "https://${aws_cognito_user_pool_domain.domain.domain}.auth.us-east-1.amazoncognito.com/oauth2/idpresponse"
  description = "URI de redirección autorizada requerida en la consola de Google Cloud"
}
