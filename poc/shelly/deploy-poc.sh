#!/bin/bash
# Deploy the PoC sensor-display script to Shelly Pro 4PM.
#
# Usage: ./deploy-poc.sh [device_ip] [script_id]
#   device_ip  - Pro 4PM IP (default: 192.168.1.10)
#   script_id  - Script slot (default: 1)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEVICE_IP="${1:-192.168.1.174}"
SCRIPT_ID="${2:-1}"
SCRIPT_FILE="$SCRIPT_DIR/sensor-display.js"

if [ ! -f "$SCRIPT_FILE" ]; then
  echo "Error: $SCRIPT_FILE not found"
  exit 1
fi

echo "Deploying PoC sensor-display to $DEVICE_IP (script slot $SCRIPT_ID)..."

# Read and JSON-encode the script
SCRIPT_CODE=$(python3 -c "
import json, sys
with open(sys.argv[1]) as f:
    print(json.dumps(f.read()))
" "$SCRIPT_FILE")

# Stop the script if running
echo "Stopping script $SCRIPT_ID..."
curl -s "http://$DEVICE_IP/rpc/Script.Stop?id=$SCRIPT_ID" > /dev/null 2>&1 || true
sleep 1

# Upload code
echo "Uploading script..."
curl -s -X POST "http://$DEVICE_IP/rpc/Script.PutCode" \
  -H "Content-Type: application/json" \
  -d "{\"id\": $SCRIPT_ID, \"code\": $SCRIPT_CODE}" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('Upload OK' if d.get('len') else 'Upload failed: ' + json.dumps(d))"

# Enable auto-start
echo "Enabling auto-start..."
curl -s -X POST "http://$DEVICE_IP/rpc/Script.SetConfig" \
  -H "Content-Type: application/json" \
  -d "{\"id\": $SCRIPT_ID, \"config\": {\"enable\": true}}" > /dev/null

# Start the script
echo "Starting script..."
curl -s "http://$DEVICE_IP/rpc/Script.Start?id=$SCRIPT_ID" > /dev/null

echo "Done! Script deployed and running on $DEVICE_IP"
echo ""
echo "Check status:"
echo "  curl http://$DEVICE_IP/rpc/Script.GetStatus?id=$SCRIPT_ID"
echo ""
echo "View logs:"
echo "  curl http://$DEVICE_IP/rpc/Script.Eval?id=$SCRIPT_ID&code=getStatus()"
