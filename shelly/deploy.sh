#!/usr/bin/env bash
set -euo pipefail

# Delay after Script.Stop (allow device to settle); set to 0 for testing
DEPLOY_STOP_DELAY="${DEPLOY_STOP_DELAY:-1}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONF="$SCRIPT_DIR/devices.conf"
LOGIC_JS="$SCRIPT_DIR/control-logic.js"
CONTROL_JS="$SCRIPT_DIR/control.js"

# Track whether deploy was called with an explicit device IP. When the user
# targets a single device (e.g. for testing), we skip the multi-device naming
# phase — it would touch unrelated devices they didn't ask about.
USER_TARGET="${1:-}"

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

# ── Provision native MQTT status reporting (Epic #254 telemetry reassembly) ──
# The server reconstructs the full greenhouse/state from each relay's native
# Shelly Gen2 status, published on "<topic_prefix>/status/switch:<id>". For
# that to work every relay device must:
#   1. have MQTT enabled with status_ntf:true  → it actually publishes status,
#   2. set topic_prefix to its own IP          → the server resolves the prefix
#      back to a device IP via its topic_prefix==IP path (no out-of-band
#      MAC→IP map needed; mirrors RELAY_TOPIC_MAP coverage in relay-status.js).
# MQTT config changes require a reboot to apply, so we provision + reboot +
# wait for each device to come back. This runs BEFORE the control script is
# touched: if a device cannot be provisioned the deploy fails here (set -e),
# leaving the previously-deployed control script in place.
#
# Gated on a full deploy (no explicit target) with MQTT_BROKER_HOST set — the
# cloud CD path. Single-device test deploys and local runs without a broker
# skip provisioning.
MQTT_REBOOT_TIMEOUT="${MQTT_REBOOT_TIMEOUT:-60}"

wait_reachable() {
  local device_ip="$1" elapsed=0
  while [ "$elapsed" -lt "$MQTT_REBOOT_TIMEOUT" ]; do
    if curl -sf -m 3 "http://$device_ip/rpc/Shelly.GetStatus" > /dev/null 2>&1; then
      echo "  $device_ip back up (${elapsed}s)"
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  echo "Error: $device_ip did not come back after its MQTT reboot (${MQTT_REBOOT_TIMEOUT}s)" >&2
  return 1
}

provision_mqtt() {
  local device_ip="$1"
  echo "Provisioning MQTT status reporting on $device_ip (topic_prefix=$device_ip, status_ntf=true)..."
  # -sf: fail loud on any non-2xx so set -e aborts the deploy before scripts.
  curl -sf -m 10 -X POST "http://$device_ip/rpc/Mqtt.SetConfig" \
    -H "Content-Type: application/json" \
    -d "{\"config\":{\"enable\":true,\"server\":\"$MQTT_BROKER_HOST:${MQTT_BROKER_PORT:-1883}\",\"status_ntf\":true,\"topic_prefix\":\"$device_ip\"}}" > /dev/null
  echo "  rebooting to apply MQTT config..."
  curl -sf -m 10 "http://$device_ip/rpc/Shelly.Reboot" > /dev/null || true
  wait_reachable "$device_ip"
}

if [ -z "$USER_TARGET" ] && [ -n "${MQTT_BROKER_HOST:-}" ]; then
  echo ""
  echo "Provisioning native relay-status MQTT on all relay devices..."
  # Relay devices only: the Pro 4PM (actuators) + the four valve Pro 2PMs.
  # The .55 spare has no mapped relays and the sensor hubs publish via the
  # sensor-config path, so neither needs status_ntf.
  for relay_ip in "$PRO4PM" "${PRO2PM_1:-}" "${PRO2PM_2:-}" "${PRO2PM_3:-}" "${PRO2PM_4:-}"; do
    [ -n "$relay_ip" ] && provision_mqtt "$relay_ip"
  done
fi

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

# ── Device + channel naming ──
# Sets the device-level name (shown in Shelly app under "All Devices") and
# per-relay labels, all derived from the hardware layout in system.yaml.
# Cosmetic only: failures are logged but never abort deployment. Skipped when
# the user targets a specific device (USER_TARGET set), since naming iterates
# across devices they may not have intended to touch.
#
# Temperature sensor (DS18B20) naming happens in server/lib/sensor-apply.js
# at role-assignment time, not here — the role→sensor mapping changes at
# runtime and has no meaning at deploy time.
set_device_name() {
  local device_ip="$1" device_name="$2"
  if curl -sf -m 5 -X POST "http://$device_ip/rpc/Sys.SetConfig" \
      -H "Content-Type: application/json" \
      -d "{\"config\":{\"device\":{\"name\":\"$device_name\"}}}" > /dev/null 2>&1; then
    echo "  device name: $device_name"
  else
    echo "  WARN: could not set device name on $device_ip (skipping)" >&2
  fi
}

set_switch_name() {
  local device_ip="$1" switch_id="$2" switch_name="$3"
  if curl -sf -m 5 -X POST "http://$device_ip/rpc/Switch.SetConfig" \
      -H "Content-Type: application/json" \
      -d "{\"id\":$switch_id,\"config\":{\"name\":\"$switch_name\"}}" > /dev/null 2>&1; then
    echo "  switch:$switch_id: $switch_name"
  else
    echo "  WARN: could not set switch:$switch_id name on $device_ip" >&2
  fi
}

apply_device_names() {
  # Pro 4PM — main controller. Switch IDs match control.js setActuators mapping.
  if [ -n "${PRO4PM:-}" ]; then
    echo "Pro 4PM @ $PRO4PM:"
    set_device_name  "$PRO4PM" "GH Controller"
    set_switch_name  "$PRO4PM" 0 "Pump"
    set_switch_name  "$PRO4PM" 1 "Fan"
    set_switch_name  "$PRO4PM" 2 "Heater (immersion)"
    set_switch_name  "$PRO4PM" 3 "Heater (space)"
  fi

  # Pro 2PM units — valve controllers. Switch IDs match VALVES in control.js.
  if [ -n "${PRO2PM_1:-}" ]; then
    echo "Pro 2PM #1 @ $PRO2PM_1:"
    set_device_name  "$PRO2PM_1" "GH Valves 1 (input low)"
    set_switch_name  "$PRO2PM_1" 0 "VI-btm"
    set_switch_name  "$PRO2PM_1" 1 "VI-top"
  fi
  if [ -n "${PRO2PM_2:-}" ]; then
    echo "Pro 2PM #2 @ $PRO2PM_2:"
    set_device_name  "$PRO2PM_2" "GH Valves 2 (input/coll)"
    set_switch_name  "$PRO2PM_2" 0 "VI-coll"
    set_switch_name  "$PRO2PM_2" 1 "VO-coll"
  fi
  if [ -n "${PRO2PM_3:-}" ]; then
    echo "Pro 2PM #3 @ $PRO2PM_3:"
    set_device_name  "$PRO2PM_3" "GH Valves 3 (output)"
    set_switch_name  "$PRO2PM_3" 0 "VO-rad"
    set_switch_name  "$PRO2PM_3" 1 "VO-tank"
  fi
  if [ -n "${PRO2PM_4:-}" ]; then
    echo "Pro 2PM #4 @ $PRO2PM_4:"
    set_device_name  "$PRO2PM_4" "GH Valves 4 (collector top)"
    set_switch_name  "$PRO2PM_4" 0 "V-air"
    # switch 1 = reserved spare (spec 024 removed the collector-top return valve).
    # Left unnamed so any future manual label in the Shelly app survives deploys.
  fi
  if [ -n "${PRO2PM_5:-}" ]; then
    echo "Pro 2PM #5 @ $PRO2PM_5:"
    set_device_name  "$PRO2PM_5" "GH Valves 5 (spare)"
  fi

  # Sensor hubs (Plus 1 + Add-on). Device-level name only; temperature
  # components are named by sensor-apply when roles are assigned.
  if [ -n "${SENSOR_1:-}" ]; then
    echo "Sensor hub 1 @ $SENSOR_1:"
    set_device_name  "$SENSOR_1" "GH Sensors 1"
  fi
  if [ -n "${SENSOR_2:-}" ]; then
    echo "Sensor hub 2 @ $SENSOR_2:"
    set_device_name  "$SENSOR_2" "GH Sensors 2"
  fi
}

if [ "${DEPLOY_SET_NAMES:-true}" = "true" ] && [ -z "$USER_TARGET" ]; then
  echo ""
  echo "Applying device names..."
  apply_device_names
fi

# ── Shelly Cloud app rename ──
# Syncs cloud/mobile-app device names with the role mapping. Non-fatal:
# the Cloud API is separate infra and a failure here shouldn't abort deploy.
# Skipped when the user targets a single device (USER_TARGET set).
if [ "${DEPLOY_SET_NAMES:-true}" = "true" ] && [ -z "$USER_TARGET" ]; then
  echo ""
  if [ -n "${SHELLY_CLOUD_TOKEN:-}${SHELLY_CLOUD_REFRESH_TOKEN:-}" ]; then
    echo "Renaming Shelly Cloud entries..."
    node "$SCRIPT_DIR/../scripts/rename-cloud-devices.mjs" || \
      echo "WARN: cloud rename failed (non-fatal) — check SHELLY_CLOUD_REFRESH_TOKEN validity" >&2
  else
    echo "Skipping Shelly Cloud rename — no SHELLY_CLOUD_TOKEN / SHELLY_CLOUD_REFRESH_TOKEN set."
    echo "To enable: obtain a 60-day refresh token (see scripts/rename-cloud-devices.mjs header)"
    echo "and store via Terraform (shelly_cloud_refresh_token variable in deploy/terraform/)."
  fi
fi

echo ""
echo "Deployment complete"
