#!/bin/bash
# Deploy the PoC sensor-display script to Shelly Pro 4PM.
#
# Usage: ./deploy-poc.sh [--no-reboot] [device_ip]
#   --no-reboot  - Skip device reboot after deploy
#   device_ip    - Pro 4PM IP (default: 192.168.1.174)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REBOOT=true

# Parse flags
while [[ "${1:-}" == --* ]]; do
  case "$1" in
    --no-reboot) REBOOT=false; shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

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

# Upload code in chunks (Shelly PutCode limit is ~1024 bytes per request)
echo "Uploading script..."
python3 -c "
import json, sys, urllib.request, time

CHUNK_SIZE = 512

with open(sys.argv[1]) as f:
    code = f.read()

script_id = int(sys.argv[2])
base_url = 'http://' + sys.argv[3] + '/rpc/Script.PutCode'
total = len(code)
offset = 0
chunk_num = 0

while offset < total:
    chunk = code[offset:offset + CHUNK_SIZE]
    append = offset > 0
    payload = json.dumps({'id': script_id, 'code': chunk, 'append': append}, ensure_ascii=False).encode('utf-8')
    req = urllib.request.Request(base_url, data=payload,
        headers={'Content-Type': 'application/json'})
    try:
        resp = urllib.request.urlopen(req, timeout=10)
        data = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        print('  ERROR on chunk %d (append=%s): HTTP %d: %s' % (chunk_num + 1, append, e.code, body))
        sys.exit(1)
    chunk_num += 1
    offset += CHUNK_SIZE
    print('  chunk %d: %d/%d bytes' % (chunk_num, min(offset, total), total))

print('Upload OK (%d bytes in %d chunks)' % (total, chunk_num))
" "$SCRIPT_FILE" "$SCRIPT_ID" "$DEVICE_IP"

# Enable auto-start
echo "Enabling auto-start..."
curl -s -X POST "http://$DEVICE_IP/rpc/Script.SetConfig" \
  -H "Content-Type: application/json" \
  -d "{\"id\": $SCRIPT_ID, \"config\": {\"enable\": true}}" > /dev/null

# Reboot device to cleanly start the script (auto-start is enabled)
if [ "$REBOOT" = true ]; then
  echo "Rebooting device..."
  curl -s "http://$DEVICE_IP/rpc/Shelly.Reboot" > /dev/null 2>&1 || true
  echo "Device rebooting — script will auto-start in ~10s"
else
  echo "Starting script..."
  curl -s -X POST "http://$DEVICE_IP/rpc/Script.Start" \
    -H "Content-Type: application/json" \
    -d "{\"id\": $SCRIPT_ID}" > /dev/null
fi

echo ""
echo "Done! Script '$SCRIPT_NAME' deployed on $DEVICE_IP (slot $SCRIPT_ID)"
echo ""
echo "Check status:"
echo "  curl \"http://$DEVICE_IP/rpc/Script.GetStatus?id=$SCRIPT_ID\""
echo ""
echo "View logs:"
echo "  curl \"http://$DEVICE_IP/rpc/Script.Eval?id=$SCRIPT_ID&code=getStatus()\""
