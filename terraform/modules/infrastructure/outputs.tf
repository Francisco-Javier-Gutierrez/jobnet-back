output "user_pool_id" {
  value = aws_cognito_user_pool.pool.id
}

output "user_pool_client_id" {
  value = aws_cognito_user_pool_client.client.id
}

output "dynamodb_table_name" {
  value = aws_dynamodb_table.jobs.name
}

output "s3_upload_bucket" {
  value = aws_s3_bucket.uploads.bucket
}

output "opensearch_endpoint" {
  value = aws_opensearch_domain.search.endpoint
}
