variable "stack_name" {
  description = "Name prefix for AWS resources"
  type        = string
}

variable "region_label" {
  description = "Label used in resource names"
  type        = string
}

variable "region_key" {
  description = "Region label exposed to signaling/media runtime"
  type        = string
}

variable "media_udp_port_range" {
  description = "UDP range exposed by media servers"
  type        = string
}

variable "create_signaling" {
  description = "Whether to create signaling service in this region"
  type        = bool
}

variable "create_media" {
  description = "Whether to create media services in this region"
  type        = bool
}

variable "signaling_image" {
  description = "Full ECR image URL for signaling"
  type        = string
}

variable "media_image" {
  description = "Full ECR image URL for media"
  type        = string
}

variable "signaling_host" {
  description = "Signaling hostname used by media services"
  type        = string
}

variable "signaling_task_cpu" {
  description = "CPU units for signaling Fargate task"
  type        = number
}

variable "signaling_task_memory" {
  description = "Memory (MiB) for signaling Fargate task"
  type        = number
}

variable "media_task_cpu" {
  description = "CPU units for media Fargate task"
  type        = number
}

variable "media_task_memory" {
  description = "Memory (MiB) for media Fargate task"
  type        = number
}

variable "signaling_desired_count" {
  description = "Desired task count for signaling service"
  type        = number
}

variable "media_ingress_desired_count" {
  description = "Desired task count for ingress media service"
  type        = number
}

variable "media_egress_desired_count" {
  description = "Desired task count for egress media service"
  type        = number
}
