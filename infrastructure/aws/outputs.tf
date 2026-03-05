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
  value     = null
  sensitive = true
}

output "shared_ssh_key_name" {
  value = null
}

output "shared_ssh_key_id" {
  value = {
    ohio             = null
    north_california = null
    north_virginia   = null
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
  value = null
}

output "signaling_public_ip" {
  value = null
}

output "signaling_public_dns" {
  value = try(module.ohio[0].signaling_public_dns, null)
}

output "media_private_ips" {
  value = {
    north_california = []
    north_virginia   = []
  }
}

output "media_public_ips" {
  value = {
    north_california = []
    north_virginia   = []
  }
}

output "ecs_clusters" {
  value = {
    ohio             = try(module.ohio[0].ecs_cluster_name, null)
    north_california = try(module.north_california[0].ecs_cluster_name, null)
    north_virginia   = try(module.north_virginia[0].ecs_cluster_name, null)
  }
}

output "ecs_services" {
  value = {
    signaling = {
      cluster = try(module.ohio[0].ecs_cluster_name, null)
      service = try(module.ohio[0].signaling_service_name, null)
      region  = "us-east-2"
    }
    media = {
      north_california = {
        cluster = try(module.north_california[0].ecs_cluster_name, null)
        ingress = try(module.north_california[0].media_ingress_service_name, null)
        egress  = try(module.north_california[0].media_egress_service_name, null)
        region  = "us-west-1"
      }
      north_virginia = {
        cluster = try(module.north_virginia[0].ecs_cluster_name, null)
        ingress = try(module.north_virginia[0].media_ingress_service_name, null)
        egress  = try(module.north_virginia[0].media_egress_service_name, null)
        region  = "us-east-1"
      }
    }
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

output "webapp_assets_bucket_name" {
  value = aws_s3_bucket.webapp_assets.bucket
}

output "webapp_assets_bucket_arn" {
  value = aws_s3_bucket.webapp_assets.arn
}

output "webapp_cdn_distribution_id" {
  value = aws_cloudfront_distribution.webapp.id
}

output "webapp_cdn_domain_name" {
  value = aws_cloudfront_distribution.webapp.domain_name
}

output "webapp_url" {
  value = "https://${aws_cloudfront_distribution.webapp.domain_name}"
}

output "cloudfront_url" {
  value = "https://${aws_cloudfront_distribution.webapp.domain_name}"
}

output "demo_control_api_endpoint" {
  value = aws_apigatewayv2_api.demo_control.api_endpoint
}

output "demo_control_start_url" {
  value = "https://${aws_cloudfront_distribution.webapp.domain_name}/demo/start"
}

output "demo_control_status_url" {
  value = "https://${aws_cloudfront_distribution.webapp.domain_name}/demo/status"
}
