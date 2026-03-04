variable "stack_name" {
  description = "Name prefix for AWS resources"
  type        = string
  default     = "signalsalad"
}

variable "shared_ssh_key_name" {
  description = "Single AWS key pair name to create and reuse for all instances"
  type        = string
  default     = "signalsalad_shared_key"
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

variable "signaling_instance_type" {
  description = "EC2 instance type for signaling node"
  type        = string
  default     = "t3.small"
}

variable "media_instance_type" {
  description = "EC2 instance type for media nodes (2 vCPU, minimum RAM class)"
  type        = string
  default     = "t3.small"

  validation {
    condition     = var.media_instance_type == "t3.small"
    error_message = "media_instance_type is pinned to t3.small to guarantee 2 vCPU with minimal RAM footprint."
  }
}

variable "ubuntu_ami_name_pattern" {
  description = "Ubuntu AMI name pattern used in each region"
  type        = string
  default     = "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"
}

variable "ubuntu_ami_owners" {
  description = "AMI owner ids for Ubuntu images (Canonical owner id)"
  type        = list(string)
  default     = ["099720109477"]
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
