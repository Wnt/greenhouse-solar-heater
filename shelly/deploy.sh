#!/usr/bin/env bash
set -euo pipefail

# Delay after Script.Stop (allow device to settle); set to 0 for testing
DEPLOY_STOP_DELAY="${DEPLOY_STOP_DELAY:-1}"

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

# Select device IP: VPN or LAN
if [ "${DEPLOY_VIA_VPN:-false}" = "true" ]; then
  DEVICE="${1:-$PRO4PM_VPN}"
  echo "Using VPN IP: $DEVICE"
else
  DEVICE="${1:-$PRO4PM}"
fi

EXPECTED_SLOT_COUNT=1  # slot 1: merged control+telemetry

# ── Ensure exactly the expected script slots exist ──
# Shelly Script.Create auto-assigns IDs (1, 2, 3...) — we can't pick IDs.
# Strategy: if slot count doesn't match, wipe all and recreate in order.
ensure_script_slots() {
  local device_ip="$1"
  local expected_count="$2"

  echo "Checking script slots on $device_ip..."

  local list_json
  list_json=$(curl -sf "http://$device_ip/rpc/Script.List" 2>/dev/null) || {
    echo "Warning: Could not list scripts on $device_ip" >&2
    return 1
  }

  local existing_ids
  existing_ids=$(echo "$list_json" | python3 -c "
import json, sys
data = json.load(sys.stdin)
ids = sorted(s['id'] for s in data.get('scripts', []))
print(' '.join(str(i) for i in ids))
" 2>/dev/null) || existing_ids=""

  # Check if we have exactly the expected sequential slots (1, 2, ...)
  local expected_seq=""
  for i in $(seq 1 "$expected_count"); do
    expected_seq="$expected_seq $i"
  done
  expected_seq="${expected_seq# }"

  if [ "$existing_ids" = "$expected_seq" ]; then
    echo "  Slots OK: $existing_ids"
    return 0
  fi

  echo "  Current slots: ${existing_ids:-(none)}"
  echo "  Expected slots: $expected_seq"
  echo "  Resetting script slots..."

  # Delete all existing scripts
  for id in $existing_ids; do
    curl -sf "http://$device_ip/rpc/Script.Stop?id=$id" > /dev/null 2>&1 || true
    curl -sf -X POST "http://$device_ip/rpc/Script.Delete" \
      -H "Content-Type: application/json" \
      -d "{\"id\":$id}" > /dev/null 2>&1 || true
  done

  # Create slots in order — IDs are auto-assigned sequentially (1, 2, ...)
  for i in $(seq 1 "$expected_count"); do
    local created_id
    created_id=$(curl -sf -X POST "http://$device_ip/rpc/Script.Create" \
      -H "Content-Type: application/json" \
      -d '{}' 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin).get('id','?'))" 2>/dev/null) || created_id="?"
    # Disable auto-start on empty slots to prevent crash-on-boot
    curl -sf -X POST "http://$device_ip/rpc/Script.SetConfig" \
      -H "Content-Type: application/json" \
      -d "{\"id\":$created_id,\"config\":{\"enable\":false}}" > /dev/null 2>&1
    echo "  Created slot $created_id"
  done

  echo "Script slots verified"
}

ensure_script_slots "$DEVICE" "$EXPECTED_SLOT_COUNT"

CONTROL_SCRIPT_ID=1

# ── Helper: upload script files to a Shelly script slot ──
upload_script() {
  local script_id="$1"
  shift
  local files=("$@")
  local device_ip="${files[-1]}"
  unset 'files[-1]'

  python3 -c "
import json, sys, urllib.request

CHUNK_SIZE = 512

# Strip full-line // comments, blank lines, and leading indentation to fit
# the 65535-byte Shelly Script.PutCode limit. Inline comments are preserved.
# Trailing inline comments stay; block comments aren't used in the sources.
def minify(src):
    out = []
    for line in src.split('\n'):
        stripped = line.lstrip()
        if not stripped or stripped.startswith('//'):
            continue
        out.append(stripped)
    return '\n'.join(out) + '\n'

content = ''
for path in sys.argv[1:-2]:
    with open(path) as f:
        content += minify(f.read())

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
" "${files[@]}" "$script_id" "$device_ip"
}

# ── Deploy control script (slot 1) ──
echo "Deploying control-logic.js + control.js to $DEVICE (script $CONTROL_SCRIPT_ID)..."

curl -s "http://$DEVICE/rpc/Script.Stop?id=$CONTROL_SCRIPT_ID" > /dev/null 2>&1 || true
sleep "$DEPLOY_STOP_DELAY"

echo "Uploading control script..."
upload_script "$CONTROL_SCRIPT_ID" "$LOGIC_JS" "$CONTROL_JS" "$DEVICE"

curl -s -X POST "http://$DEVICE/rpc/Script.SetConfig" \
  -H "Content-Type: application/json" \
  -d "{\"id\":$CONTROL_SCRIPT_ID,\"config\":{\"name\":\"control\",\"enable\":true}}" > /dev/null

echo "Control script auto-start enabled"
curl -s "http://$DEVICE/rpc/Script.Start?id=$CONTROL_SCRIPT_ID" > /dev/null
echo "Control script started on $DEVICE"

# ── Configure MQTT on device (if MQTT_BROKER_HOST is set) ──
if [ -n "${MQTT_BROKER_HOST:-}" ]; then
  echo ""
  echo "Configuring MQTT broker: $MQTT_BROKER_HOST:${MQTT_BROKER_PORT:-1883}"
  curl -s -X POST "http://$DEVICE/rpc/Mqtt.SetConfig" \
    -H "Content-Type: application/json" \
    -d "{\"config\":{\"enable\":true,\"server\":\"$MQTT_BROKER_HOST:${MQTT_BROKER_PORT:-1883}\"}}" > /dev/null
  echo "MQTT configured — device may reboot to apply"
fi

echo ""
echo "Deployment complete"
