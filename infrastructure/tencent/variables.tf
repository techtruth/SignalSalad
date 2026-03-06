variable "stack_name" {
  description = "Name prefix for Tencent resources"
  type        = string
  default     = "signalsalad"
}

variable "shared_ssh_key_name" {
  description = "Single Tencent key pair name to create and reuse for all instances"
  type        = string
  default     = "signalsalad_shared_key"
}

variable "media_regions" {
  description = "Media regions: guangzhou, shanghai, and one USA non-siliconvalley region (virginia)"
  type        = list(string)
  default     = ["guangzhou", "shanghai", "virginia"]

  validation {
    condition = (
      length(var.media_regions) == 3 &&
      contains(var.media_regions, "guangzhou") &&
      contains(var.media_regions, "shanghai") &&
      contains(var.media_regions, "virginia")
    )
    error_message = "media_regions must be exactly [\"guangzhou\", \"shanghai\", \"virginia\"] (order does not matter)."
  }
}

variable "signaling_region" {
  description = "Signaling region is fixed to Silicon Valley"
  type        = string
  default     = "siliconvalley"

  validation {
    condition     = var.signaling_region == "siliconvalley"
    error_message = "signaling_region must be \"siliconvalley\"."
  }
}

variable "ubuntu_image_name_regex" {
  description = "Regex used to pick a public Ubuntu image in each region"
  type        = string
  default     = "(?i)ubuntu"
}

variable "allowed_ssh_cidr" {
  description = "CIDR block allowed to SSH"
  type        = string
  default     = "0.0.0.0/0"
}

variable "media_udp_port_range" {
  description = "UDP range exposed by media servers"
  type        = string
  default     = "10000-10100"
}

variable "tcr_namespace" {
  description = "Tencent TCR namespace used for pushed images"
  type        = string
  default     = "signalsalad"
}
