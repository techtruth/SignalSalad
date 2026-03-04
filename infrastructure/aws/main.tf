locals {
  enabled_regions = toset(concat(var.media_regions, [var.signaling_region]))
}

resource "tls_private_key" "shared_ssh" {
  algorithm = "ED25519"
}

resource "aws_key_pair" "ohio" {
  provider   = aws.ohio
  key_name   = var.shared_ssh_key_name
  public_key = tls_private_key.shared_ssh.public_key_openssh
}

resource "aws_key_pair" "north_california" {
  provider   = aws.north_california
  key_name   = var.shared_ssh_key_name
  public_key = tls_private_key.shared_ssh.public_key_openssh
}

resource "aws_key_pair" "north_virginia" {
  provider   = aws.north_virginia
  key_name   = var.shared_ssh_key_name
  public_key = tls_private_key.shared_ssh.public_key_openssh
}

module "ohio" {
  count  = contains(local.enabled_regions, "ohio") ? 1 : 0
  source = "./modules/regional_stack"

  providers = {
    aws = aws.ohio
  }

  stack_name              = var.stack_name
  region_label            = "ohio"
  ssh_key_name            = aws_key_pair.ohio.key_name
  allowed_ssh_cidr        = var.allowed_ssh_cidr
  media_udp_port_range    = var.media_udp_port_range
  media_instance_type     = var.media_instance_type
  signaling_instance_type = var.signaling_instance_type
  ubuntu_ami_name_pattern = var.ubuntu_ami_name_pattern
  ubuntu_ami_owners       = var.ubuntu_ami_owners
  create_media            = false
  create_signaling        = true
}

module "north_california" {
  count  = contains(local.enabled_regions, "north_california") ? 1 : 0
  source = "./modules/regional_stack"

  providers = {
    aws = aws.north_california
  }

  stack_name              = var.stack_name
  region_label            = "north-california"
  ssh_key_name            = aws_key_pair.north_california.key_name
  allowed_ssh_cidr        = var.allowed_ssh_cidr
  media_udp_port_range    = var.media_udp_port_range
  media_instance_type     = var.media_instance_type
  signaling_instance_type = var.signaling_instance_type
  ubuntu_ami_name_pattern = var.ubuntu_ami_name_pattern
  ubuntu_ami_owners       = var.ubuntu_ami_owners
  create_media            = contains(var.media_regions, "north_california")
  create_signaling        = false
}

module "north_virginia" {
  count  = contains(local.enabled_regions, "north_virginia") ? 1 : 0
  source = "./modules/regional_stack"

  providers = {
    aws = aws.north_virginia
  }

  stack_name              = var.stack_name
  region_label            = "north-virginia"
  ssh_key_name            = aws_key_pair.north_virginia.key_name
  allowed_ssh_cidr        = var.allowed_ssh_cidr
  media_udp_port_range    = var.media_udp_port_range
  media_instance_type     = var.media_instance_type
  signaling_instance_type = var.signaling_instance_type
  ubuntu_ami_name_pattern = var.ubuntu_ami_name_pattern
  ubuntu_ami_owners       = var.ubuntu_ami_owners
  create_media            = contains(var.media_regions, "north_virginia")
  create_signaling        = false
}
