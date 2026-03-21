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

# Step 4: Apply the service stack
log "Applying service stack"
docker compose -f "$COMPOSE_FILE" up -d --remove-orphans

log "Deploy complete"
