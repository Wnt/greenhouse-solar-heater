output "server_ip" {
  description = "Public IP address of the UpCloud server — create an A record pointing your domain to this IP"
  value       = upcloud_server.monitor.network_interface[0].ip_address
}

output "domain" {
  description = "Domain name for the server"
  value       = var.domain
}
