#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONF="$SCRIPT_DIR/devices.conf"
LOGIC_JS="$SCRIPT_DIR/control-logic.js"
CONTROL_JS="$SCRIPT_DIR/control.js"

if [ ! -f "$CONF" ]; then
  echo "Error: $CONF not found" >&2
  exit 1
fi

if [ ! -f "$LOGIC_JS" ]; then
  echo "Error: $LOGIC_JS not found" >&2
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

echo "Deploying control-logic.js + control.js to $DEVICE (script $SCRIPT_ID)..."

# Stop existing script (ignore errors if not running)
curl -s "http://$DEVICE/rpc/Script.Stop?id=$SCRIPT_ID" > /dev/null 2>&1 || true
sleep 1

# Concatenate logic + shell and JSON-escape for upload
CODE=$(python3 -c "
import json, sys
content = ''
for path in sys.argv[1:]:
    with open(path) as f:
        content += f.read() + '\n'
print(json.dumps(content))
" "$LOGIC_JS" "$CONTROL_JS")

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
