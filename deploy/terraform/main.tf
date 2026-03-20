terraform {
  required_version = ">= 1.5"
  required_providers {
    upcloud = {
      source  = "UpCloudLtd/upcloud"
      version = "~> 5.0"
    }
  }
}

provider "upcloud" {
  # Credentials via UPCLOUD_USERNAME and UPCLOUD_PASSWORD env vars
}

# ── Server ──

resource "upcloud_server" "monitor" {
  hostname = replace(var.domain, ".", "-")
  zone     = var.upcloud_zone
  plan     = var.server_plan

  template {
    storage = "Ubuntu Server 24.04 LTS (Noble Numbat)"
    size    = 25
  }

  network_interface {
    type = "public"
  }

  login {
    keys = [var.ssh_public_key]
  }

  metadata = true

  user_data = file("${path.module}/cloud-init.yaml")
}

# ── Firewall ──

resource "upcloud_firewall_rules" "monitor" {
  server_id = upcloud_server.monitor.id

  firewall_rule {
    action                 = "accept"
    direction              = "in"
    family                 = "IPv4"
    protocol               = "tcp"
    destination_port_start = 22
    destination_port_end   = 22
    comment                = "SSH"
  }

  firewall_rule {
    action                 = "accept"
    direction              = "in"
    family                 = "IPv4"
    protocol               = "tcp"
    destination_port_start = 80
    destination_port_end   = 80
    comment                = "HTTP (Caddy redirect to HTTPS)"
  }

  firewall_rule {
    action                 = "accept"
    direction              = "in"
    family                 = "IPv4"
    protocol               = "tcp"
    destination_port_start = 443
    destination_port_end   = 443
    comment                = "HTTPS"
  }

  firewall_rule {
    action                 = "accept"
    direction              = "in"
    family                 = "IPv4"
    protocol               = "udp"
    destination_port_start = 51820
    destination_port_end   = 51820
    comment                = "WireGuard VPN (not active yet, ready for later)"
  }

  firewall_rule {
    action    = "drop"
    direction = "in"
    family    = "IPv4"
    comment   = "Drop all other inbound IPv4"
  }

  firewall_rule {
    action    = "drop"
    direction = "in"
    family    = "IPv6"
    comment   = "Drop all inbound IPv6"
  }
}
