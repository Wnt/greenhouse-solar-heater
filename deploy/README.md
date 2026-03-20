# Deployment

## Required GitHub Secrets

Configure these in **Settings > Secrets and variables > Actions**:

| Secret | Description |
|--------|-------------|
| `DEPLOY_SSH_KEY` | Ed25519 private key for the `deploy` user on UpCloud |
| `DEPLOY_HOST` | UpCloud server IP or domain name |
| `DEPLOY_USER` | SSH username (typically `deploy`) |

## Server Setup (deploy user)

After Terraform provisions the server, cloud-init creates a `deploy` user with Docker group membership. The SSH key from `DEPLOY_SSH_KEY` must match the authorized key on the server.

### Generate deploy key

```bash
ssh-keygen -t ed25519 -C "github-actions-deploy" -f deploy_key -N ""
# Add deploy_key.pub to /home/deploy/.ssh/authorized_keys on the server
# Add deploy_key (private) as DEPLOY_SSH_KEY in GitHub Secrets
```

### Server directory structure

```
/opt/app/
├── docker-compose.yml   # Copy from deploy/docker/docker-compose.yml
├── Caddyfile            # Copy from deploy/docker/Caddyfile
├── .env                 # Environment variables (RPID, ORIGIN, SESSION_SECRET, etc.)
├── data/                # Persistent credentials.json
└── caddy_data/          # Caddy TLS certificates
```

### Required .env on server

```bash
RPID=monitor.example.com
ORIGIN=https://monitor.example.com
SESSION_SECRET=$(openssl rand -hex 32)
DOMAIN=monitor.example.com
VPN_CHECK_HOST=192.168.1.86:80
```
