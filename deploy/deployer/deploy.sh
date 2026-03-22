#!/bin/sh
# Deployer entrypoint: copy config, validate, pull images, apply.
# Runs as a one-shot container via systemd timer.
# Config files are baked into the image at /config/.
# Host volume is mounted at /opt/app/.
# Docker socket is mounted at /var/run/docker.sock.

set -e

CONFIG_SRC="/config"
APP_DIR="/opt/app"
COMPOSE_FILE="$APP_DIR/docker-compose.yml"
VPN_CONFIG="$APP_DIR/wg0.conf"

log() {
  echo "[deployer] $(date -Iseconds) $1"
}

# Step 1: Copy config files from image to host volume
log "Copying config files to $APP_DIR"
cp "$CONFIG_SRC/docker-compose.yml" "$APP_DIR/docker-compose.yml"
cp "$CONFIG_SRC/Caddyfile" "$APP_DIR/Caddyfile"
cp "$CONFIG_SRC/config.env" "$APP_DIR/config.env"

# Step 2: Merge .env.secrets + config.env → .env
# Secrets (cloud-init) win on duplicate keys. Legacy fallback: if .env.secrets
# does not exist but .env does, skip merge to avoid breaking existing servers.
SECRETS_FILE="$APP_DIR/.env.secrets"
CONFIG_FILE="$APP_DIR/config.env"
ENV_FILE="$APP_DIR/.env"

if [ -f "$SECRETS_FILE" ]; then
  log "Merging .env.secrets + config.env → .env"
  # Start with config.env (mutable service config)
  cp "$CONFIG_FILE" "$ENV_FILE.tmp"
  # Overlay secrets: for each key in .env.secrets, replace or append in merged file
  while IFS= read -r line || [ -n "$line" ]; do
    # Skip empty lines and comments
    case "$line" in
      ''|'#'*) continue ;;
    esac
    key="${line%%=*}"
    # Remove existing key from merged file (if present) and append secret value
    grep -v "^${key}=" "$ENV_FILE.tmp" > "$ENV_FILE.tmp2" || true
    mv "$ENV_FILE.tmp2" "$ENV_FILE.tmp"
    echo "$line" >> "$ENV_FILE.tmp"
  done < "$SECRETS_FILE"
  mv "$ENV_FILE.tmp" "$ENV_FILE"
  chmod 0600 "$ENV_FILE"
elif [ -f "$ENV_FILE" ]; then
  log "No .env.secrets found — using existing .env (legacy mode)"
else
  log "WARNING: No .env.secrets or .env found — services may fail to start"
fi

# Step 2b: Ensure GITHUB_REPO is lowercase (Docker image refs require it)
if grep -q '^GITHUB_REPO=' "$ENV_FILE" 2>/dev/null; then
  REPO_VAL=$(grep '^GITHUB_REPO=' "$ENV_FILE" | head -1 | cut -d= -f2-)
  REPO_LC=$(echo "$REPO_VAL" | tr '[:upper:]' '[:lower:]')
  if [ "$REPO_VAL" != "$REPO_LC" ]; then
    log "Lowercasing GITHUB_REPO: $REPO_VAL → $REPO_LC"
    sed -i "s|^GITHUB_REPO=.*|GITHUB_REPO=$REPO_LC|" "$ENV_FILE"
  fi
fi

# Step 3: Validate compose config
log "Validating docker-compose.yml"
if ! docker compose -f "$COMPOSE_FILE" config --quiet 2>/dev/null; then
  log "ERROR: Invalid docker-compose.yml — aborting. Existing services unaffected."
  exit 1
fi

# Step 4: Pull service images
log "Pulling service images"
if ! docker compose -f "$COMPOSE_FILE" pull --quiet 2>/dev/null; then
  log "WARNING: Some images failed to pull — continuing with available images"
fi

# Step 5: Resolve app image name for one-shot S3 operations
# Use the 'app' service image specifically — head -1 is unreliable when
# profiles (e.g. vpn) add services whose images have init systems that
# never exit, causing docker-run one-shots to hang indefinitely.
APP_IMAGE=$(cd "$APP_DIR" && docker compose config --images app 2>/dev/null)
if [ -z "$APP_IMAGE" ]; then
  log "WARNING: Could not determine app image — skipping VPN config sync"
else
  # Step 6: Download VPN config from S3 (if available)
  log "Checking S3 for VPN config"
  if ! timeout 30 docker run --rm --env-file "$APP_DIR/.env" \
    -v "$APP_DIR:/opt/app" \
    "$APP_IMAGE" \
    node poc/lib/vpn-config.js download /opt/app/wg0.conf 2>&1; then
    log "WARNING: VPN config download failed — continuing without VPN config"
  fi

  # Step 7: Upload VPN config to S3 if local exists but S3 doesn't (bootstrap)
  if [ -f "$VPN_CONFIG" ]; then
    log "Local VPN config found — ensuring S3 backup exists"
    if ! timeout 30 docker run --rm --env-file "$APP_DIR/.env" \
      -v "$APP_DIR:/opt/app" \
      "$APP_IMAGE" \
      node poc/lib/vpn-config.js upload /opt/app/wg0.conf 2>&1; then
      log "WARNING: VPN config upload failed — continuing"
    fi
  fi
fi

# Step 8: Apply the service stack
log "Applying service stack"
docker compose -f "$COMPOSE_FILE" up -d --remove-orphans

log "Deploy complete"
