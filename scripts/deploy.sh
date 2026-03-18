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

# Upload code in chunks (Shelly PutCode limit is ~1024 bytes per request)
echo "Uploading code..."
python3 -c "
import json, sys, urllib.request

CHUNK_SIZE = 512

content = ''
for path in sys.argv[1:-2]:
    with open(path) as f:
        content += f.read() + '\n'

script_id = int(sys.argv[-2])
base_url = 'http://' + sys.argv[-1] + '/rpc/Script.PutCode'
total = len(content)
offset = 0
chunk_num = 0

while offset < total:
    chunk = content[offset:offset + CHUNK_SIZE]
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
" "$LOGIC_JS" "$CONTROL_JS" "$SCRIPT_ID" "$DEVICE"

# Enable auto-start on boot
curl -s -X POST "http://$DEVICE/rpc/Script.SetConfig" \
  -H "Content-Type: application/json" \
  -d "{\"id\":$SCRIPT_ID,\"config\":{\"enable\":true}}" > /dev/null

echo "Auto-start enabled"

# Start the script
curl -s "http://$DEVICE/rpc/Script.Start?id=$SCRIPT_ID" > /dev/null
echo "Script started on $DEVICE"
