locals {
  enabled_regions = toset(concat(var.media_regions, [var.signaling_region]))
}

module "ohio" {
  count  = contains(local.enabled_regions, "ohio") ? 1 : 0
  source = "./modules/regional_stack"

  providers = {
    aws = aws.ohio
  }

  stack_name                  = var.stack_name
  region_label                = "ohio"
  region_key                  = "ohio"
  media_udp_port_range        = var.media_udp_port_range
  create_media                = false
  create_signaling            = true
  signaling_image             = "${aws_ecr_repository.repos["signaling"].repository_url}:latest"
  media_image                 = "${aws_ecr_repository.repos["media"].repository_url}:latest"
  signaling_host              = ""
  signaling_task_cpu          = var.signaling_task_cpu
  signaling_task_memory       = var.signaling_task_memory
  media_task_cpu              = var.media_task_cpu
  media_task_memory           = var.media_task_memory
  signaling_desired_count     = var.signaling_desired_count
  media_ingress_desired_count = var.media_ingress_desired_count
  media_egress_desired_count  = var.media_egress_desired_count
}

module "north_california" {
  count  = contains(local.enabled_regions, "north_california") ? 1 : 0
  source = "./modules/regional_stack"

  providers = {
    aws = aws.north_california
  }

  stack_name                  = var.stack_name
  region_label                = "north-california"
  region_key                  = "north_california"
  media_udp_port_range        = var.media_udp_port_range
  create_media                = contains(var.media_regions, "north_california")
  create_signaling            = false
  signaling_image             = "${aws_ecr_repository.repos["signaling"].repository_url}:latest"
  media_image                 = "${aws_ecr_repository.repos["media"].repository_url}:latest"
  signaling_host              = module.ohio[0].signaling_public_dns
  signaling_task_cpu          = var.signaling_task_cpu
  signaling_task_memory       = var.signaling_task_memory
  media_task_cpu              = var.media_task_cpu
  media_task_memory           = var.media_task_memory
  signaling_desired_count     = var.signaling_desired_count
  media_ingress_desired_count = var.media_ingress_desired_count
  media_egress_desired_count  = var.media_egress_desired_count
}

module "north_virginia" {
  count  = contains(local.enabled_regions, "north_virginia") ? 1 : 0
  source = "./modules/regional_stack"

  providers = {
    aws = aws.north_virginia
  }

  stack_name                  = var.stack_name
  region_label                = "north-virginia"
  region_key                  = "north_virginia"
  media_udp_port_range        = var.media_udp_port_range
  create_media                = contains(var.media_regions, "north_virginia")
  create_signaling            = false
  signaling_image             = "${aws_ecr_repository.repos["signaling"].repository_url}:latest"
  media_image                 = "${aws_ecr_repository.repos["media"].repository_url}:latest"
  signaling_host              = module.ohio[0].signaling_public_dns
  signaling_task_cpu          = var.signaling_task_cpu
  signaling_task_memory       = var.signaling_task_memory
  media_task_cpu              = var.media_task_cpu
  media_task_memory           = var.media_task_memory
  signaling_desired_count     = var.signaling_desired_count
  media_ingress_desired_count = var.media_ingress_desired_count
  media_egress_desired_count  = var.media_egress_desired_count
}
