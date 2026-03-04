data "tencentcloud_availability_zones_by_product" "available" {
  product = "cvm"
}

locals {
  zone_names   = sort(data.tencentcloud_availability_zones_by_product.available.zones[*].name)
  primary_zone = try(local.zone_names[0], null)
}

data "tencentcloud_instance_types" "primary_zone" {
  count = local.primary_zone == null ? 0 : 1

  availability_zone = local.primary_zone
  cpu_core_count    = 2
  exclude_sold_out  = true
}

locals {
  primary_zone_candidates_all = sort([
    for it in try(data.tencentcloud_instance_types.primary_zone[0].instance_types, []) :
    format("%012.3f|%s", tonumber(it.memory_size), it.instance_type)
  ])

  primary_zone_candidates_preferred = sort([
    for it in try(data.tencentcloud_instance_types.primary_zone[0].instance_types, []) :
    format("%012.3f|%s", tonumber(it.memory_size), it.instance_type)
    if startswith(upper(split(it.instance_type, ".")[0]), "SA") || startswith(upper(split(it.instance_type, ".")[0]), "S")
  ])

  selected_zone_candidates = (
    length(local.primary_zone_candidates_preferred) > 0
    ? local.primary_zone_candidates_preferred
    : local.primary_zone_candidates_all
  )
  resolved_instance_type = length(local.selected_zone_candidates) > 0 ? split("|", local.selected_zone_candidates[0])[1] : null
}

data "tencentcloud_images" "ubuntu_selected_type" {
  count = local.resolved_instance_type == null ? 0 : 1

  image_type       = ["PUBLIC_IMAGE"]
  image_name_regex = var.ubuntu_image_name_regex
  instance_type    = local.resolved_instance_type
}

locals {
  ubuntu_image_id = local.resolved_instance_type != null ? try(
    data.tencentcloud_images.ubuntu_selected_type[0].images[0].image_id,
    null
  ) : null
}

resource "tencentcloud_vpc" "this" {
  name       = "${var.stack_name}-${var.region_label}-vpc"
  cidr_block = var.vpc_cidr
}

resource "tencentcloud_subnet" "this" {
  count = local.primary_zone == null ? 0 : 1

  name              = "${var.stack_name}-${var.region_label}-${local.primary_zone}-subnet"
  vpc_id            = tencentcloud_vpc.this.id
  cidr_block        = cidrsubnet(var.vpc_cidr, var.subnet_newbits, 0)
  availability_zone = local.primary_zone
}

resource "tencentcloud_security_group" "this" {
  name        = "${var.stack_name}-${var.region_label}-sg"
  description = "Ingress for web/signaling/media ports"
}

resource "tencentcloud_security_group_rule" "ssh" {
  count = (var.create_signaling || var.create_media) ? 1 : 0

  security_group_id = tencentcloud_security_group.this.id
  type              = "ingress"
  ip_protocol       = "TCP"
  port_range        = "22"
  cidr_ip           = var.allowed_ssh_cidr
  policy            = "accept"
}

resource "tencentcloud_security_group_rule" "http" {
  count = var.create_signaling ? 1 : 0

  security_group_id = tencentcloud_security_group.this.id
  type              = "ingress"
  ip_protocol       = "TCP"
  port_range        = "80"
  cidr_ip           = "0.0.0.0/0"
  policy            = "accept"
}

resource "tencentcloud_security_group_rule" "https" {
  count = var.create_signaling ? 1 : 0

  security_group_id = tencentcloud_security_group.this.id
  type              = "ingress"
  ip_protocol       = "TCP"
  port_range        = "443"
  cidr_ip           = "0.0.0.0/0"
  policy            = "accept"
}

resource "tencentcloud_security_group_rule" "signaling_tcp" {
  for_each = var.create_signaling ? toset(["1188"]) : toset([])

  security_group_id = tencentcloud_security_group.this.id
  type              = "ingress"
  ip_protocol       = "TCP"
  port_range        = each.value
  cidr_ip           = "0.0.0.0/0"
  policy            = "accept"
}

resource "tencentcloud_security_group_rule" "media_udp" {
  count = var.create_media ? 1 : 0

  security_group_id = tencentcloud_security_group.this.id
  type              = "ingress"
  ip_protocol       = "UDP"
  port_range        = var.media_udp_port_range
  cidr_ip           = "0.0.0.0/0"
  policy            = "accept"
}

resource "tencentcloud_security_group_rule" "egress_all" {
  security_group_id = tencentcloud_security_group.this.id
  type              = "egress"
  ip_protocol       = "ALL"
  cidr_ip           = "0.0.0.0/0"
  policy            = "accept"
}

resource "tencentcloud_instance" "media" {
  count = var.create_media && local.primary_zone != null ? 1 : 0

  instance_name              = "${var.stack_name}-${var.region_label}-media"
  availability_zone          = local.primary_zone
  image_id                   = local.ubuntu_image_id
  instance_type              = local.resolved_instance_type
  vpc_id                     = tencentcloud_vpc.this.id
  subnet_id                  = tencentcloud_subnet.this[0].id
  orderly_security_groups    = [tencentcloud_security_group.this.id]
  key_ids                    = [var.ssh_key_id]
  allocate_public_ip         = true
  internet_charge_type       = "TRAFFIC_POSTPAID_BY_HOUR"
  internet_max_bandwidth_out = 20

  lifecycle {
    precondition {
      condition     = local.primary_zone != null
      error_message = "No available zones found for this region."
    }
    precondition {
      condition     = local.ubuntu_image_id != null
      error_message = "No Ubuntu image matched ubuntu_image_name_regex in this region."
    }
    precondition {
      condition     = local.resolved_instance_type != null
      error_message = "No 2-vCPU instance type was found in the selected zone."
    }
  }
}

resource "tencentcloud_instance" "signaling" {
  count = var.create_signaling && local.primary_zone != null ? 1 : 0

  instance_name              = "${var.stack_name}-${var.region_label}-signaling"
  availability_zone          = local.primary_zone
  image_id                   = local.ubuntu_image_id
  instance_type              = local.resolved_instance_type
  vpc_id                     = tencentcloud_vpc.this.id
  subnet_id                  = tencentcloud_subnet.this[0].id
  orderly_security_groups    = [tencentcloud_security_group.this.id]
  key_ids                    = [var.ssh_key_id]
  allocate_public_ip         = true
  internet_charge_type       = "TRAFFIC_POSTPAID_BY_HOUR"
  internet_max_bandwidth_out = 20

  lifecycle {
    precondition {
      condition     = local.primary_zone != null
      error_message = "No available zones found for this region."
    }
    precondition {
      condition     = local.ubuntu_image_id != null
      error_message = "No Ubuntu image matched ubuntu_image_name_regex in this region."
    }
    precondition {
      condition     = local.resolved_instance_type != null
      error_message = "No 2-vCPU instance type was found in the selected zone."
    }
  }
}
