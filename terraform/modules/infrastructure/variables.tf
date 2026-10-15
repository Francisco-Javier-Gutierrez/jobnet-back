variable "environment" {
  type = string
}

variable "enable_opensearch" {
  type        = bool
  default     = false
  description = "Controla si se despliega el clúster de OpenSearch Service. Si es false, se elimina para ahorrar costos."
}

variable "cognito_domain_prefix" {
  type        = string
  default     = "jobnet-auth"
  description = "Prefijo para el dominio de Cognito (OAuth 2.0 y federación Google)."
}

variable "google_client_id" {
  type        = string
  default     = ""
  description = "Client ID de OAuth 2.0 de Google Cloud Console para federación con Cognito."
}

variable "google_client_secret" {
  type        = string
  default     = ""
  sensitive   = true
  description = "Client Secret de OAuth 2.0 de Google Cloud Console."
}
