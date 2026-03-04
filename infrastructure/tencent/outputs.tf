output "signaling_region" {
  value = var.signaling_region
}

output "vpc_ids" {
  value = {
    guangzhou     = try(module.guangzhou[0].vpc_id, null)
    shanghai      = try(module.shanghai[0].vpc_id, null)
    siliconvalley = try(module.siliconvalley[0].vpc_id, null)
    virginia      = try(module.ashburn[0].vpc_id, null)
  }
}

output "ssh_private_key" {
  value     = tls_private_key.shared_ssh.private_key_openssh
  sensitive = true
}

output "shared_ssh_key_name" {
  value = tencentcloud_key_pair.shared.key_name
}

output "shared_ssh_key_id" {
  value = tencentcloud_key_pair.shared.id
}

output "subnet_ids" {
  value = {
    guangzhou     = try(module.guangzhou[0].subnet_ids, [])
    shanghai      = try(module.shanghai[0].subnet_ids, [])
    siliconvalley = try(module.siliconvalley[0].subnet_ids, [])
    virginia      = try(module.ashburn[0].subnet_ids, [])
  }
}

output "signaling_private_ip" {
  value = try(module.siliconvalley[0].signaling_private_ip, null)
}

output "signaling_public_ip" {
  value = try(module.siliconvalley[0].signaling_public_ip, null)
}

output "media_private_ips" {
  value = {
    guangzhou = try(module.guangzhou[0].media_private_ips, [])
    shanghai  = try(module.shanghai[0].media_private_ips, [])
    virginia  = try(module.ashburn[0].media_private_ips, [])
  }
}

output "media_public_ips" {
  value = {
    guangzhou = try(module.guangzhou[0].media_public_ips, [])
    shanghai  = try(module.shanghai[0].media_public_ips, [])
    virginia  = try(module.ashburn[0].media_public_ips, [])
  }
}

output "tcr_registry_domain" {
  value = tencentcloud_tcr_instance.main.public_domain
}

output "tcr_namespace" {
  value = tencentcloud_tcr_namespace.main.name
}

output "tcr_repositories" {
  value = {
    for name, repo in tencentcloud_tcr_repository.repos : name => repo.url
  }
}
