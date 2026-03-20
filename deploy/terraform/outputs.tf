output "server_ip" {
  description = "Public IP address of the UpCloud server"
  value       = upcloud_server.monitor.network_interface[0].ip_address
}

output "domain" {
  description = "Domain name pointing to the server"
  value       = var.domain
}
