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
  # Credentials via UPCLOUD_TOKEN env var (token-based auth, see constitution V)
}

# ── Object Storage ──

resource "upcloud_managed_object_storage" "credentials" {
  name              = "${replace(var.domain, ".", "-")}-objsto"
  region            = var.objsto_region
  configured_status = "started"

  network {
    family = "IPv4"
    name   = "public"
    type   = "public"
  }
}

resource "upcloud_managed_object_storage_bucket" "credentials" {
  service_uuid = upcloud_managed_object_storage.credentials.id
  name         = "credentials"
}

resource "upcloud_managed_object_storage_user" "app" {
  service_uuid = upcloud_managed_object_storage.credentials.id
  username     = "app"
}

resource "upcloud_managed_object_storage_user_access_key" "app" {
  service_uuid = upcloud_managed_object_storage.credentials.id
  username     = upcloud_managed_object_storage_user.app.username
  status       = "Active"
}

resource "upcloud_managed_object_storage_policy" "app_rw" {
  service_uuid = upcloud_managed_object_storage.credentials.id
  name         = "app-credentials-rw"
  description  = "Read/write access to credentials bucket"
  document = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"]
      Resource = ["arn:aws:s3:::credentials", "arn:aws:s3:::credentials/*"]
    }]
  })
}

resource "upcloud_managed_object_storage_user_policy" "app_rw" {
  service_uuid = upcloud_managed_object_storage.credentials.id
  username     = upcloud_managed_object_storage_user.app.username
  name         = upcloud_managed_object_storage_policy.app_rw.name
}

# ── Server ──

resource "upcloud_server" "monitor" {
  hostname = replace(var.domain, ".", "-")
  zone     = var.upcloud_zone
  plan     = var.server_plan

  template {
    storage = "Ubuntu Server 24.04 LTS (Noble Numbat)"
    size    = 10
  }

  network_interface {
    type = "public"
  }

  login {
    keys = [var.ssh_public_key]
  }

  metadata = true

  user_data = templatefile("${path.module}/cloud-init.yaml", {
    domain            = var.domain
    session_secret    = var.session_secret
    s3_endpoint       = "https://${upcloud_managed_object_storage.credentials.id}.upcloudobjects.com"
    s3_bucket         = upcloud_managed_object_storage_bucket.credentials.name
    s3_access_key_id  = upcloud_managed_object_storage_user_access_key.app.access_key_id
    s3_secret_key     = upcloud_managed_object_storage_user_access_key.app.secret_access_key
    s3_region         = var.objsto_region
    github_repo       = var.github_repo
    vpn_check_host    = var.enable_vpn ? "192.168.1.86:80" : ""
    enable_vpn        = var.enable_vpn
  })
}

# ── Firewall ──

resource "upcloud_firewall_rules" "monitor" {
  server_id = upcloud_server.monitor.id

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

  dynamic "firewall_rule" {
    for_each = var.enable_vpn ? [1] : []
    content {
      action                 = "accept"
      direction              = "in"
      family                 = "IPv4"
      protocol               = "udp"
      destination_port_start = 51820
      destination_port_end   = 51820
      comment                = "WireGuard VPN"
    }
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
