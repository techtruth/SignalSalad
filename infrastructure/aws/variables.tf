variable "stack_name" {
  description = "Name prefix for AWS resources"
  type        = string
  default     = "signalsalad"
}

variable "media_regions" {
  description = "Media regions: north_california and north_virginia"
  type        = list(string)
  default     = ["north_california", "north_virginia"]

  validation {
    condition = (
      length(var.media_regions) == 2 &&
      contains(var.media_regions, "north_california") &&
      contains(var.media_regions, "north_virginia")
    )
    error_message = "media_regions must be exactly [\"north_california\", \"north_virginia\"] (order does not matter)."
  }
}

variable "signaling_region" {
  description = "Signaling region is fixed to ohio"
  type        = string
  default     = "ohio"

  validation {
    condition     = var.signaling_region == "ohio"
    error_message = "signaling_region must be \"ohio\"."
  }
}

variable "media_udp_port_range" {
  description = "UDP range exposed by media servers"
  type        = string
  default     = "10000-10100"
}

variable "signaling_task_cpu" {
  description = "CPU units for signaling Fargate task"
  type        = number
  default     = 512
}

variable "signaling_task_memory" {
  description = "Memory (MiB) for signaling Fargate task"
  type        = number
  default     = 1024
}

variable "media_task_cpu" {
  description = "CPU units for media Fargate task"
  type        = number
  default     = 1024
}

variable "media_task_memory" {
  description = "Memory (MiB) for media Fargate task"
  type        = number
  default     = 2048
}

variable "signaling_desired_count" {
  description = "Desired task count for signaling service"
  type        = number
  default     = 0
}

variable "media_ingress_desired_count" {
  description = "Desired task count for ingress media service per media region"
  type        = number
  default     = 0
}

variable "media_egress_desired_count" {
  description = "Desired task count for egress media service per media region"
  type        = number
  default     = 0
}

variable "demo_server_warm_minutes" {
  description = "Minutes demo ECS services stay scaled to 1 before automatic scale-down to 0"
  type        = number
  default     = 15
}

variable "demo_bot_default_count" {
  description = "Default number of bots to request when launchBots is enabled"
  type        = number
  default     = 20
}

variable "demo_bot_max_count" {
  description = "Maximum number of bots accepted by demo launcher request"
  type        = number
  default     = 50
}

variable "enable_demo_bot_worker" {
  description = "Whether Terraform should manage the demo bot worker Lambda resources"
  type        = bool
  default     = false
}

variable "demo_bot_worker_image_tag" {
  description = "Container image tag for the demo bot worker Lambda image"
  type        = string
  default     = "latest"
}

variable "demo_bot_worker_timeout_seconds" {
  description = "Timeout for each demo bot worker Lambda invocation"
  type        = number
  default     = 900
}

variable "demo_bot_worker_memory_mb" {
  description = "Memory size (MB) for demo bot worker Lambda"
  type        = number
  default     = 2048
}

variable "demo_bot_worker_ephemeral_storage_mb" {
  description = "Ephemeral /tmp storage (MB) for demo bot worker Lambda"
  type        = number
  default     = 2048
}

variable "demo_bot_room_egress_ready_timeout_ms" {
  description = "Timeout in ms for bot wait on roomEgressReady"
  type        = number
  default     = 90000
}

variable "demo_bot_media_enable_timeout_ms" {
  description = "Timeout in ms for bot wait on media enable after toggle"
  type        = number
  default     = 90000
}

variable "paypal_client_id" {
  description = "PayPal REST app client ID for demo payment verification"
  type        = string
  default     = ""
  sensitive   = true
}

variable "paypal_client_secret" {
  description = "PayPal REST app client secret for demo payment verification"
  type        = string
  default     = ""
  sensitive   = true
}

variable "paypal_environment" {
  description = "PayPal API environment: sandbox or live"
  type        = string
  default     = "sandbox"

  validation {
    condition     = contains(["sandbox", "live"], var.paypal_environment)
    error_message = "paypal_environment must be either sandbox or live."
  }
}

variable "paypal_bot_unit_price_usd" {
  description = "USD unit price per bot for PayPal checkout"
  type        = string
  default     = "1.00"
}

variable "ecr_namespace" {
  description = "ECR repository namespace prefix"
  type        = string
  default     = "signalsalad"
}

variable "ecr_force_delete" {
  description = "Allow Terraform destroy to delete non-empty ECR repositories"
  type        = bool
  default     = true
}

variable "webapp_assets_force_destroy" {
  description = "Allow Terraform destroy to delete non-empty webapp assets bucket"
  type        = bool
  default     = true
}

variable "webapp_cdn_price_class" {
  description = "CloudFront price class used for the webapp CDN distribution"
  type        = string
  default     = "PriceClass_100"

  validation {
    condition = contains([
      "PriceClass_All",
      "PriceClass_200",
      "PriceClass_100",
    ], var.webapp_cdn_price_class)
    error_message = "webapp_cdn_price_class must be one of PriceClass_All, PriceClass_200, or PriceClass_100."
  }
}
