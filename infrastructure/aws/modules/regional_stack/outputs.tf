output "vpc_id" {
  value = aws_default_vpc.this.id
}

output "subnet_ids" {
  value = [for subnet in aws_default_subnet.primary : subnet.id]
}

output "media_instance_ids" {
  value = [for instance in aws_instance.media : instance.id]
}

output "media_private_ips" {
  value = [for instance in aws_instance.media : instance.private_ip]
}

output "media_public_ips" {
  value = [for instance in aws_instance.media : instance.public_ip]
}

output "signaling_instance_id" {
  value = length(aws_instance.signaling) > 0 ? aws_instance.signaling[0].id : null
}

output "signaling_private_ip" {
  value = length(aws_instance.signaling) > 0 ? aws_instance.signaling[0].private_ip : null
}

output "signaling_public_ip" {
  value = length(aws_instance.signaling) > 0 ? aws_instance.signaling[0].public_ip : null
}
