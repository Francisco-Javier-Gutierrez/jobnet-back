variable "environment" {
  type = string
}

variable "enable_opensearch" {
  type        = bool
  default     = false
  description = "Controla si se despliega el clúster de OpenSearch Service. Si es false, se elimina para ahorrar costos."
}
