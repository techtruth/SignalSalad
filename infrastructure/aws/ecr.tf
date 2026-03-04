locals {
  ecr_repo_names = toset(["webapp", "signaling", "media"])
}

resource "aws_ecr_repository" "repos" {
  for_each = local.ecr_repo_names

  name                 = "${var.ecr_namespace}/${each.key}"
  force_delete         = var.ecr_force_delete
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}
