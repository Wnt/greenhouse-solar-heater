#!/usr/bin/env bash
set -euo pipefail

# Delay after Script.Stop (allow device to settle); set to 0 for testing
DEPLOY_STOP_DELAY="${DEPLOY_STOP_DELAY:-1}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONF="$SCRIPT_DIR/devices.conf"
LOGIC_JS="$SCRIPT_DIR/control-logic.js"
CONTROL_JS="$SCRIPT_DIR/control.js"
TELEMETRY_JS="$SCRIPT_DIR/telemetry.js"

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

CONTROL_SCRIPT_ID="${2:-1}"
TELEMETRY_SCRIPT_ID="${3:-3}"

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
  -d "{\"id\":$CONTROL_SCRIPT_ID,\"config\":{\"enable\":true}}" > /dev/null

echo "Control script auto-start enabled"
curl -s "http://$DEVICE/rpc/Script.Start?id=$CONTROL_SCRIPT_ID" > /dev/null
echo "Control script started on $DEVICE"

# ── Deploy telemetry script (slot 3) ──
if [ -f "$TELEMETRY_JS" ]; then
  echo ""
  echo "Deploying telemetry.js to $DEVICE (script $TELEMETRY_SCRIPT_ID)..."

  curl -s "http://$DEVICE/rpc/Script.Stop?id=$TELEMETRY_SCRIPT_ID" > /dev/null 2>&1 || true
  sleep "$DEPLOY_STOP_DELAY"

  echo "Uploading telemetry script..."
  upload_script "$TELEMETRY_SCRIPT_ID" "$TELEMETRY_JS" "$DEVICE"

  curl -s -X POST "http://$DEVICE/rpc/Script.SetConfig" \
    -H "Content-Type: application/json" \
    -d "{\"id\":$TELEMETRY_SCRIPT_ID,\"config\":{\"enable\":true}}" > /dev/null

  echo "Telemetry script auto-start enabled"
  curl -s "http://$DEVICE/rpc/Script.Start?id=$TELEMETRY_SCRIPT_ID" > /dev/null
  echo "Telemetry script started on $DEVICE"
fi

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
