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

# Step 2: Validate compose config
log "Validating docker-compose.yml"
if ! docker compose -f "$COMPOSE_FILE" config --quiet 2>/dev/null; then
  log "ERROR: Invalid docker-compose.yml — aborting. Existing services unaffected."
  exit 1
fi

# Step 3: Pull service images
log "Pulling service images"
if ! docker compose -f "$COMPOSE_FILE" pull --quiet 2>/dev/null; then
  log "WARNING: Some images failed to pull — continuing with available images"
fi

# Step 4: Resolve app image name for one-shot S3 operations
APP_IMAGE=$(docker compose -f "$COMPOSE_FILE" config --images 2>/dev/null | head -1)
if [ -z "$APP_IMAGE" ]; then
  log "WARNING: Could not determine app image — skipping VPN config sync"
else
  # Step 5: Download VPN config from S3 (if available)
  log "Checking S3 for VPN config"
  if ! docker run --rm --env-file "$APP_DIR/.env" \
    -v "$APP_DIR:/opt/app" \
    "$APP_IMAGE" \
    node poc/lib/vpn-config.js download /opt/app/wg0.conf 2>&1; then
    log "WARNING: VPN config download failed — continuing without VPN config"
  fi

  # Step 6: Upload VPN config to S3 if local exists but S3 doesn't (bootstrap)
  if [ -f "$VPN_CONFIG" ]; then
    log "Local VPN config found — ensuring S3 backup exists"
    if ! docker run --rm --env-file "$APP_DIR/.env" \
      -v "$APP_DIR:/opt/app" \
      "$APP_IMAGE" \
      node poc/lib/vpn-config.js upload /opt/app/wg0.conf 2>&1; then
      log "WARNING: VPN config upload failed — continuing"
    fi
  fi
fi

# Step 7: Apply the service stack
log "Applying service stack"
docker compose -f "$COMPOSE_FILE" up -d --remove-orphans

log "Deploy complete"
