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

variable "manage_github_actions_secrets" {
  description = "Whether Terraform should update repository GitHub Actions secrets for webapp CDN deploy"
  type        = bool
  default     = false
}

variable "github_owner" {
  description = "GitHub owner (user or org) for the repository where secrets are managed"
  type        = string
  default     = "techtruth"

  validation {
    condition     = length(trimspace(var.github_owner)) > 0
    error_message = "github_owner cannot be empty."
  }
}

variable "github_repository_name" {
  description = "GitHub repository name for Actions secret management"
  type        = string
  default     = "SignalSalad"

  validation {
    condition     = length(trimspace(var.github_repository_name)) > 0
    error_message = "github_repository_name cannot be empty."
  }
}
