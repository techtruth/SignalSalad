variable "stack_name" {
  description = "Name prefix for AWS resources"
  type        = string
}

variable "region_label" {
  description = "Label used in resource names (region key)"
  type        = string
}

variable "ssh_key_name" {
  description = "AWS key pair name to attach to instances"
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
  description = "Whether to create media node in this region"
  type        = bool
}

variable "media_instance_type" {
  description = "EC2 instance type for media node"
  type        = string
}

variable "signaling_instance_type" {
  description = "EC2 instance type for signaling node"
  type        = string
}

variable "ubuntu_ami_name_pattern" {
  description = "Ubuntu AMI name pattern to select"
  type        = string
}

variable "ubuntu_ami_owners" {
  description = "AMI owner ids used for AMI selection"
  type        = list(string)
}
