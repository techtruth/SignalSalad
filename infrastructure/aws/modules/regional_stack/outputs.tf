output "vpc_id" {
  value = aws_default_vpc.this.id
}

output "subnet_ids" {
  value = local.subnet_ids
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.this.name
}

output "ecs_cluster_arn" {
  value = aws_ecs_cluster.this.arn
}

output "signaling_service_name" {
  value = length(aws_ecs_service.signaling) > 0 ? aws_ecs_service.signaling[0].name : null
}

output "signaling_service_arn" {
  value = length(aws_ecs_service.signaling) > 0 ? aws_ecs_service.signaling[0].id : null
}

output "media_ingress_service_name" {
  value = length(aws_ecs_service.media_ingress) > 0 ? aws_ecs_service.media_ingress[0].name : null
}

output "media_ingress_service_arn" {
  value = length(aws_ecs_service.media_ingress) > 0 ? aws_ecs_service.media_ingress[0].id : null
}

output "media_egress_service_name" {
  value = length(aws_ecs_service.media_egress) > 0 ? aws_ecs_service.media_egress[0].name : null
}

output "media_egress_service_arn" {
  value = length(aws_ecs_service.media_egress) > 0 ? aws_ecs_service.media_egress[0].id : null
}

output "media_instance_ids" {
  value = []
}

output "media_private_ips" {
  value = []
}

output "media_public_ips" {
  value = []
}

output "signaling_instance_id" {
  value = null
}

output "signaling_private_ip" {
  value = null
}

output "signaling_public_ip" {
  value = null
}

output "signaling_public_dns" {
  value = length(aws_lb.signaling) > 0 ? aws_lb.signaling[0].dns_name : null
}
