locals {
  enabled_regions = toset(concat(var.media_regions, [var.signaling_region]))
}

resource "tls_private_key" "shared_ssh" {
  algorithm = "ED25519"
}

resource "tencentcloud_key_pair" "shared" {
  key_name   = var.shared_ssh_key_name
  public_key = tls_private_key.shared_ssh.public_key_openssh
}

module "guangzhou" {
  count  = contains(local.enabled_regions, "guangzhou") ? 1 : 0
  source = "./modules/regional_stack"

  providers = {
    tencentcloud = tencentcloud.guangzhou
  }

  stack_name              = var.stack_name
  region_label            = "guangzhou"
  vpc_cidr                = var.region_vpc_cidrs["guangzhou"]
  ssh_key_id              = tencentcloud_key_pair.shared.id
  ubuntu_image_name_regex = var.ubuntu_image_name_regex
  allowed_ssh_cidr        = var.allowed_ssh_cidr
  media_udp_port_range    = var.media_udp_port_range
  create_media            = contains(var.media_regions, "guangzhou")
  create_signaling        = false
}

module "siliconvalley" {
  count  = contains(local.enabled_regions, "siliconvalley") ? 1 : 0
  source = "./modules/regional_stack"

  providers = {
    tencentcloud = tencentcloud.siliconvalley
  }

  stack_name              = var.stack_name
  region_label            = "siliconvalley"
  vpc_cidr                = var.region_vpc_cidrs["siliconvalley"]
  ssh_key_id              = tencentcloud_key_pair.shared.id
  ubuntu_image_name_regex = var.ubuntu_image_name_regex
  allowed_ssh_cidr        = var.allowed_ssh_cidr
  media_udp_port_range    = var.media_udp_port_range
  create_media            = false
  create_signaling        = true
}

module "ashburn" {
  count  = contains(local.enabled_regions, "virginia") ? 1 : 0
  source = "./modules/regional_stack"

  providers = {
    tencentcloud = tencentcloud.ashburn
  }

  stack_name              = var.stack_name
  region_label            = "ashburn"
  vpc_cidr                = var.region_vpc_cidrs["virginia"]
  ssh_key_id              = tencentcloud_key_pair.shared.id
  ubuntu_image_name_regex = var.ubuntu_image_name_regex
  allowed_ssh_cidr        = var.allowed_ssh_cidr
  media_udp_port_range    = var.media_udp_port_range
  create_media            = contains(var.media_regions, "virginia")
  create_signaling        = false
}

module "shanghai" {
  count  = contains(local.enabled_regions, "shanghai") ? 1 : 0
  source = "./modules/regional_stack"

  providers = {
    tencentcloud = tencentcloud.shanghai
  }

  stack_name              = var.stack_name
  region_label            = "shanghai"
  vpc_cidr                = var.region_vpc_cidrs["shanghai"]
  ssh_key_id              = tencentcloud_key_pair.shared.id
  ubuntu_image_name_regex = var.ubuntu_image_name_regex
  allowed_ssh_cidr        = var.allowed_ssh_cidr
  media_udp_port_range    = var.media_udp_port_range
  create_media            = contains(var.media_regions, "shanghai")
  create_signaling        = false
}
