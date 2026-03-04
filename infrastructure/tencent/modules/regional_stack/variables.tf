variable "stack_name" {
  description = "Name prefix for Tencent resources"
  type        = string
}

variable "region_label" {
  description = "Label used in resource names (region key)"
  type        = string
}

variable "ssh_key_id" {
  description = "Tencent key pair id to attach to instances"
  type        = string
}

variable "allowed_ssh_cidr" {
  description = "CIDR block allowed to SSH"
  type        = string
}

variable "media_udp_port_range" {
  description = "UDP range exposed by media servers"
  type        = string
}

variable "create_signaling" {
  description = "Whether to create signaling node in this region"
  type        = bool
}

variable "create_media" {
  description = "Whether to create media nodes in this region"
  type        = bool
}

variable "ubuntu_image_name_regex" {
  description = "Regex used to pick a public Ubuntu image"
  type        = string
}

variable "subnet_newbits" {
  description = "Additional bits used to carve subnets from VPC CIDR"
  type        = number
  default     = 8
}
