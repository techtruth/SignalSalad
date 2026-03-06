resource "tencentcloud_tcr_instance" "main" {
  name                  = "${var.stack_name}-tcr"
  instance_type         = "basic"
  registry_charge_type  = 1
  open_public_operation = true

  security_policy {
    cidr_block  = "0.0.0.0/0"
    description = "Allow pull/push from any source"
  }
}

resource "tencentcloud_tcr_namespace" "main" {
  instance_id = tencentcloud_tcr_instance.main.id
  name        = var.tcr_namespace
  is_public   = false
}

resource "tencentcloud_tcr_repository" "repos" {
  for_each = toset(["webapp", "signaling", "media"])

  instance_id    = tencentcloud_tcr_instance.main.id
  namespace_name = tencentcloud_tcr_namespace.main.name
  name           = each.key
  force_delete   = true
}
