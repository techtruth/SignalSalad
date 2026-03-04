output "vpc_id" {
  value = tencentcloud_vpc.this.id
}

output "subnet_ids" {
  value = [for subnet in tencentcloud_subnet.this : subnet.id]
}

output "media_instance_ids" {
  value = [for instance in tencentcloud_instance.media : instance.id]
}

output "media_private_ips" {
  value = [for instance in tencentcloud_instance.media : instance.private_ip]
}

output "media_public_ips" {
  value = [for instance in tencentcloud_instance.media : instance.public_ip]
}

output "signaling_instance_id" {
  value = length(tencentcloud_instance.signaling) > 0 ? tencentcloud_instance.signaling[0].id : null
}

output "signaling_private_ip" {
  value = length(tencentcloud_instance.signaling) > 0 ? tencentcloud_instance.signaling[0].private_ip : null
}

output "signaling_public_ip" {
  value = length(tencentcloud_instance.signaling) > 0 ? tencentcloud_instance.signaling[0].public_ip : null
}
