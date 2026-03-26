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
VPN_CONFIG="$APP_DIR/openvpn.conf"

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
APP_IMAGE=$(cd "$APP_DIR" && docker compose config --images app 2>/dev/null | grep -v openvpn | head -1)
if [ -z "$APP_IMAGE" ]; then
  log "WARNING: Could not determine app image — skipping VPN config sync"
else
  log "Resolved app image: $APP_IMAGE"
  # Step 6: Download VPN config from S3 (if available)
  # --dns 172.17.0.1: systemd-resolved listens on the docker0 bridge IP
  # (configured via cloud-init DNSStubListenerExtra), so one-shot containers
  # on the default bridge network can resolve external hostnames.
  # Ensure the target file is writable by app user (UID 1000) — the deployer
  # runs as root but the app image runs as 1000:1000.
  touch "$VPN_CONFIG" && chown 1000:1000 "$VPN_CONFIG"
  log "Checking S3 for VPN config"
  if ! timeout 30 docker run --rm --dns 172.17.0.1 --env-file "$APP_DIR/.env" \
    -v "$APP_DIR:/opt/app" \
    "$APP_IMAGE" \
    node monitor/lib/vpn-config.js download /opt/app/openvpn.conf 2>&1; then
    log "WARNING: VPN config download failed — continuing without VPN config"
  fi

  # Step 6b: Fetch DATABASE_URL from S3 and add to .env
  log "Checking S3 for database URL"
  DB_URL=$(timeout 30 docker run --rm --dns 172.17.0.1 --env-file "$APP_DIR/.env" \
    "$APP_IMAGE" \
    node monitor/lib/db-config.js load 2>/dev/null) || true
  if [ -n "$DB_URL" ]; then
    # Add/replace DATABASE_URL in .env
    grep -v '^DATABASE_URL=' "$ENV_FILE" > "$ENV_FILE.tmp" || true
    echo "DATABASE_URL=$DB_URL" >> "$ENV_FILE.tmp"
    mv "$ENV_FILE.tmp" "$ENV_FILE"
    chmod 0600 "$ENV_FILE"
    log "DATABASE_URL loaded from S3 and added to .env"
  else
    log "No DATABASE_URL found in S3 — database features will be disabled"
  fi

  # Step 6c: Fetch New Relic license key from S3 and add to .env
  log "Checking S3 for New Relic license key"
  NR_KEY=$(timeout 30 docker run --rm --dns 172.17.0.1 --env-file "$APP_DIR/.env" \
    "$APP_IMAGE" \
    node monitor/lib/nr-config.js load 2>/dev/null) || true
  if [ -n "$NR_KEY" ]; then
    # Add/replace NEW_RELIC_LICENSE_KEY and NRIA_LICENSE_KEY in .env
    grep -v '^NEW_RELIC_LICENSE_KEY=' "$ENV_FILE" > "$ENV_FILE.tmp" || true
    grep -v '^NRIA_LICENSE_KEY=' "$ENV_FILE.tmp" > "$ENV_FILE.tmp2" || true
    echo "NEW_RELIC_LICENSE_KEY=$NR_KEY" >> "$ENV_FILE.tmp2"
    echo "NRIA_LICENSE_KEY=$NR_KEY" >> "$ENV_FILE.tmp2"
    mv "$ENV_FILE.tmp2" "$ENV_FILE"
    rm -f "$ENV_FILE.tmp"
    chmod 0600 "$ENV_FILE"
    log "New Relic license key loaded from S3 and added to .env"
  else
    log "No New Relic license key found in S3 — observability disabled"
  fi

  # Step 7: Upload VPN config to S3 if local exists but S3 doesn't (bootstrap)
  if [ -f "$VPN_CONFIG" ]; then
    log "Local VPN config found — ensuring S3 backup exists"
    if ! timeout 30 docker run --rm --dns 172.17.0.1 --env-file "$APP_DIR/.env" \
      -v "$APP_DIR:/opt/app" \
      "$APP_IMAGE" \
      node monitor/lib/vpn-config.js upload /opt/app/openvpn.conf 2>&1; then
      log "WARNING: VPN config upload failed — continuing"
    fi
  fi
fi

# Step 7b: Template nri-postgresql config with DATABASE_URL credentials
NRI_PG_TEMPLATE="$CONFIG_SRC/nri-postgresql-config.yml"
NRI_PG_CONFIG="$APP_DIR/nri-postgresql-config.yml"
if [ -f "$NRI_PG_TEMPLATE" ]; then
  DB_URL_ENV=$(grep '^DATABASE_URL=' "$ENV_FILE" 2>/dev/null | cut -d= -f2-)
  if [ -n "$DB_URL_ENV" ]; then
    # Parse postgres://user:pass@host:port/dbname?sslmode=require
    PG_USER=$(echo "$DB_URL_ENV" | sed -n 's|.*//\([^:]*\):.*|\1|p')
    PG_PASSWORD=$(echo "$DB_URL_ENV" | sed -n 's|.*//[^:]*:\([^@]*\)@.*|\1|p')
    PG_HOST=$(echo "$DB_URL_ENV" | sed -n 's|.*@\([^:]*\):.*|\1|p')
    PG_PORT=$(echo "$DB_URL_ENV" | sed -n 's|.*:\([0-9]*\)/.*|\1|p')
    PG_DATABASE=$(echo "$DB_URL_ENV" | sed -n 's|.*/\([^?]*\).*|\1|p')
    sed -e "s|__PG_HOST__|$PG_HOST|g" \
        -e "s|__PG_PORT__|$PG_PORT|g" \
        -e "s|__PG_USER__|$PG_USER|g" \
        -e "s|__PG_PASSWORD__|$PG_PASSWORD|g" \
        -e "s|__PG_DATABASE__|$PG_DATABASE|g" \
        "$NRI_PG_TEMPLATE" > "$NRI_PG_CONFIG"
    chmod 0600 "$NRI_PG_CONFIG"
    log "nri-postgresql config templated with DATABASE_URL credentials"
  else
    # Copy template as-is (will fail to connect but won't block startup)
    cp "$NRI_PG_TEMPLATE" "$NRI_PG_CONFIG"
    log "No DATABASE_URL — nri-postgresql config not templated"
  fi
fi

# Step 8: Apply the service stack
# Enable monitoring profile (newrelic-infra, nri-postgresql) if NR license key is configured
COMPOSE_PROFILES=""
if grep -q '^NEW_RELIC_LICENSE_KEY=.\+' "$ENV_FILE" 2>/dev/null; then
  COMPOSE_PROFILES="--profile monitoring"
  log "Applying service stack with monitoring profile"
else
  log "Applying service stack (no monitoring — NEW_RELIC_LICENSE_KEY not set)"
fi
docker compose -f "$COMPOSE_FILE" $COMPOSE_PROFILES up -d --remove-orphans

# Step 8b: Remove unused images to prevent disk filling up
log "Pruning unused Docker images"
docker image prune -a -f 2>/dev/null || true

# Step 9: Deploy Shelly scripts via VPN (optional)
# Runs inside the app container which shares the OpenVPN network namespace.
CONTROLLER_VPN_IP=$(grep '^CONTROLLER_VPN_IP=' "$ENV_FILE" 2>/dev/null | cut -d= -f2-)
if [ -n "$CONTROLLER_VPN_IP" ] && [ -n "$APP_IMAGE" ]; then
  log "Deploying Shelly scripts to $CONTROLLER_VPN_IP via VPN"
  if ! timeout 60 docker compose -f "$COMPOSE_FILE" exec -T app \
    env DEPLOY_VIA_VPN=true CONTROLLER_VPN_IP="$CONTROLLER_VPN_IP" \
    bash shelly/deploy.sh 2>&1; then
    log "WARNING: Shelly script deployment failed — continuing"
  fi
else
  log "Skipping Shelly deployment (CONTROLLER_VPN_IP not set)"
fi

log "Deploy complete"
