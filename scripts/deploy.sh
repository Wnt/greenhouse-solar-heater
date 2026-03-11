#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONF="$SCRIPT_DIR/devices.conf"
CONTROL_JS="$SCRIPT_DIR/control.js"

if [ ! -f "$CONF" ]; then
  echo "Error: $CONF not found" >&2
  exit 1
fi

if [ ! -f "$CONTROL_JS" ]; then
  echo "Error: $CONTROL_JS not found" >&2
  exit 1
fi

# shellcheck source=/dev/null
source "$CONF"

DEVICE="${1:-$PRO4PM}"
SCRIPT_ID="${2:-1}"

echo "Deploying control.js to $DEVICE (script $SCRIPT_ID)..."

# Stop existing script (ignore errors if not running)
curl -s "http://$DEVICE/rpc/Script.Stop?id=$SCRIPT_ID" > /dev/null 2>&1 || true
sleep 1

# Read and JSON-escape the script source
CODE=$(python3 -c "
import json, sys
with open(sys.argv[1]) as f:
    print(json.dumps(f.read()))
" "$CONTROL_JS")

# Upload code
echo "Uploading code..."
RESULT=$(curl -s -X POST "http://$DEVICE/rpc/Script.PutCode" \
  -H "Content-Type: application/json" \
  -d "{\"id\":$SCRIPT_ID,\"code\":$CODE}")

if echo "$RESULT" | grep -q '"error"'; then
  echo "Error uploading code: $RESULT" >&2
  exit 1
fi
echo "Upload OK"

# Enable auto-start on boot
curl -s -X POST "http://$DEVICE/rpc/Script.SetConfig" \
  -H "Content-Type: application/json" \
  -d "{\"id\":$SCRIPT_ID,\"config\":{\"enable\":true}}" > /dev/null

echo "Auto-start enabled"

# Start the script
curl -s "http://$DEVICE/rpc/Script.Start?id=$SCRIPT_ID" > /dev/null
echo "Script started on $DEVICE"
