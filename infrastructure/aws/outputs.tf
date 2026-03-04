output "signaling_region" {
  value = var.signaling_region
}

output "vpc_ids" {
  value = {
    ohio             = try(module.ohio[0].vpc_id, null)
    north_california = try(module.north_california[0].vpc_id, null)
    north_virginia   = try(module.north_virginia[0].vpc_id, null)
  }
}

output "ssh_private_key" {
  value     = tls_private_key.shared_ssh.private_key_openssh
  sensitive = true
}

output "shared_ssh_key_name" {
  value = aws_key_pair.ohio.key_name
}

output "shared_ssh_key_id" {
  value = {
    ohio             = aws_key_pair.ohio.key_pair_id
    north_california = aws_key_pair.north_california.key_pair_id
    north_virginia   = aws_key_pair.north_virginia.key_pair_id
  }
}

output "subnet_ids" {
  value = {
    ohio             = try(module.ohio[0].subnet_ids, [])
    north_california = try(module.north_california[0].subnet_ids, [])
    north_virginia   = try(module.north_virginia[0].subnet_ids, [])
  }
}

output "signaling_private_ip" {
  value = try(module.ohio[0].signaling_private_ip, null)
}

output "signaling_public_ip" {
  value = try(module.ohio[0].signaling_public_ip, null)
}

output "media_private_ips" {
  value = {
    north_california = try(module.north_california[0].media_private_ips, [])
    north_virginia   = try(module.north_virginia[0].media_private_ips, [])
  }
}

output "media_public_ips" {
  value = {
    north_california = try(module.north_california[0].media_public_ips, [])
    north_virginia   = try(module.north_virginia[0].media_public_ips, [])
  }
}

output "ecr_registry_domain" {
  value = split("/", aws_ecr_repository.repos["webapp"].repository_url)[0]
}

output "ecr_namespace" {
  value = var.ecr_namespace
}

output "ecr_repositories" {
  value = {
    for name, repo in aws_ecr_repository.repos : name => repo.repository_url
  }
}
