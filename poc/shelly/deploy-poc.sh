#!/bin/bash
# Deploy the PoC sensor-display script to Shelly Pro 4PM.
#
# Usage: ./deploy-poc.sh [device_ip]
#   device_ip  - Pro 4PM IP (default: 192.168.1.174)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEVICE_IP="${1:-192.168.1.174}"
SCRIPT_NAME="sensor-display"
SCRIPT_FILE="$SCRIPT_DIR/sensor-display.js"

if [ ! -f "$SCRIPT_FILE" ]; then
  echo "Error: $SCRIPT_FILE not found"
  exit 1
fi

echo "Deploying PoC sensor-display to $DEVICE_IP..."

# Build the JSON payload with python for safe encoding
PAYLOAD=$(python3 -c "
import json, sys
with open(sys.argv[1]) as f:
    code = f.read()
print(json.dumps({'code': code}))
" "$SCRIPT_FILE")

# List existing scripts to find one named sensor-display, or create new
echo "Checking existing scripts..."
SCRIPT_LIST=$(curl -s "http://$DEVICE_IP/rpc/Script.List")
SCRIPT_ID=$(python3 -c "
import json, sys
data = json.loads(sys.argv[1])
for s in data.get('scripts', []):
    if s.get('name') == sys.argv[2]:
        print(s['id'])
        sys.exit(0)
print('')
" "$SCRIPT_LIST" "$SCRIPT_NAME")

if [ -z "$SCRIPT_ID" ]; then
  echo "Creating new script slot..."
  CREATE_RESP=$(curl -s -X POST "http://$DEVICE_IP/rpc/Script.Create" \
    -H "Content-Type: application/json" \
    -d "{\"name\": \"$SCRIPT_NAME\"}")
  SCRIPT_ID=$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['id'])" "$CREATE_RESP")
  echo "Created script slot $SCRIPT_ID"
else
  echo "Found existing script '$SCRIPT_NAME' at slot $SCRIPT_ID"
fi

# Stop the script if running
echo "Stopping script $SCRIPT_ID..."
curl -s "http://$DEVICE_IP/rpc/Script.Stop" \
  -H "Content-Type: application/json" \
  -d "{\"id\": $SCRIPT_ID}" > /dev/null 2>&1 || true
sleep 1

# Upload code using PutCode with JSON body built by python
echo "Uploading script..."
UPLOAD_RESP=$(python3 -c "
import json, sys, urllib.request
with open(sys.argv[1]) as f:
    code = f.read()
payload = json.dumps({'id': int(sys.argv[2]), 'code': code}).encode()
req = urllib.request.Request(
    'http://' + sys.argv[3] + '/rpc/Script.PutCode',
    data=payload,
    headers={'Content-Type': 'application/json'})
resp = urllib.request.urlopen(req, timeout=10)
data = json.loads(resp.read())
if 'len' in data:
    print('Upload OK (%d bytes)' % data['len'])
else:
    print('Upload failed: ' + json.dumps(data))
    sys.exit(1)
" "$SCRIPT_FILE" "$SCRIPT_ID" "$DEVICE_IP")
echo "$UPLOAD_RESP"

# Enable auto-start
echo "Enabling auto-start..."
curl -s -X POST "http://$DEVICE_IP/rpc/Script.SetConfig" \
  -H "Content-Type: application/json" \
  -d "{\"id\": $SCRIPT_ID, \"config\": {\"enable\": true}}" > /dev/null

# Start the script
echo "Starting script..."
curl -s -X POST "http://$DEVICE_IP/rpc/Script.Start" \
  -H "Content-Type: application/json" \
  -d "{\"id\": $SCRIPT_ID}" > /dev/null

echo ""
echo "Done! Script '$SCRIPT_NAME' deployed and running on $DEVICE_IP (slot $SCRIPT_ID)"
echo ""
echo "Check status:"
echo "  curl \"http://$DEVICE_IP/rpc/Script.GetStatus?id=$SCRIPT_ID\""
echo ""
echo "View logs:"
echo "  curl \"http://$DEVICE_IP/rpc/Script.Eval?id=$SCRIPT_ID&code=getStatus()\""
