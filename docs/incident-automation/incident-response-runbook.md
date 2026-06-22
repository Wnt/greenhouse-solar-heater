# Incident Response Runbook — Greenhouse Solar Heating System

This runbook is the prompt for the Claude cloud incident-response routine. Follow every step in order; do not skip triage before remediation. The routine fires when the health endpoint is unreachable or when the application emits a `shelly_script_crash` routine event.

---

## Step 0 — Materialize cluster access

Before anything else, write the kubeconfig from the environment variable that was injected into this cloud environment:

```bash
mkdir -p ~/.kube && echo "$KUBECONFIG_B64" | base64 -d > ~/.kube/config && chmod 600 ~/.kube/config
kubectl get pods -n default
```

If `kubectl get pods` fails, the cluster may be unreachable from this environment. Note the error and proceed to the notification step only.

---

## Triage

### 1. Read the alert

The routine trigger text will say one of:
- `"Shelly script crash detected: <error message>"` — the on-device control script crashed (Deliverable C)
- (future) `"App OOM"` or `"503"` — the app container is down or unhealthy (Deliverables A/B)

### 2. Gather current cluster state

```bash
# List all pods and their restart counts
kubectl get pods -n default

# For any pod that shows restarts or non-Running status, inspect it:
kubectl get pod <pod-name> -n default -o json | \
  node -e "
    var d=''; process.stdin.on('data',c=>d+=c);
    process.stdin.on('end',()=>{
      var p=JSON.parse(d);
      p.status.containerStatuses.forEach(c=>{
        console.log(c.name, 'restarts:', c.restartCount, 'state:', JSON.stringify(c.state));
      });
    })
  "
```

### 3. Check recent Shelly script crashes from the database

```bash
kubectl exec deploy/app -c app -n default -- node -e "
  const db = require('./server/lib/db');
  db.pool.query(
    'SELECT id, created_at, error_msg FROM script_crashes ORDER BY created_at DESC LIMIT 5'
  ).then(r => console.log(JSON.stringify(r.rows, null, 2))).catch(e => console.error(e));
"
```

### 4. Check application health endpoint

```bash
curl -s https://greenhouse.madekivi.fi/health
```

A healthy response is `{"status":"ok"}`. Any non-200 or connection refused means the app container is down.

### 5. Identify the incident type

Based on triage, classify as one of:

- **(A) App OOM crash-loop** — the `app` container is restarting, health endpoint is 503 or unreachable, `kubectl describe pod` shows `OOMKilled`
- **(B) OpenVPN sidecar crash-loop** — the `openvpn` container is restarting; app may be up but device control is broken (MQTT not reachable)
- **(C) Shelly control-script crash-loop** — app is up and healthy; the alert text mentions `"Shelly script crash detected"`

---

## Remediation

### (A) App OOM crash-loop

The ML trainer runs daily and can consume significant memory on long history windows. Disabling it is the safe first response.

```bash
# Disable the ML trainer and restart the deployment
kubectl set env deployment/app DISABLE_ML_TRAINER=true -n default
kubectl rollout restart deployment/app -n default

# Watch rollout progress
kubectl rollout status deployment/app -n default

# Confirm health
curl -s https://greenhouse.madekivi.fi/health
```

After recovery, open a GitHub draft PR to bound the trainer's history window (see `server/lib/forecast/ml/ml-trainer.js`, the `--window` parameter). The committed fallback in PR #234 bounds it to 30 days; if OOM recurs, reduce further.

### (B) OpenVPN sidecar crash-loop / 503 on device control

The openvpn sidecar occasionally crashes on cipher negotiation with older configurations. The current Dockerfile already includes `--allow-deprecated-insecure-static-crypto`; a simple restart is usually sufficient.

```bash
kubectl rollout restart deployment/app -n default
kubectl rollout status deployment/app -n default
curl -s https://greenhouse.madekivi.fi/health
```

If restarts continue, check the openvpn container logs:

```bash
kubectl logs deploy/app -c openvpn -n default --tail=50
```

Look for TLS handshake errors. If the cipher mismatch is a different algorithm, open a draft PR to add the appropriate flag to `deploy/docker/openvpn/Dockerfile`.

### (C) Shelly control-script crash-loop

The on-device control script (Shelly Pro 4PM) has crashed. The app is still running and will attempt auto-restart, but if auto-restart is exhausted the collector can overheat.

**Step 1: Check the current operating mode**

```bash
kubectl exec deploy/app -c app -n default -- \
  curl -sS http://192.168.30.50/rpc/Shelly.GetStatus
```

Or read the mode from the KV store:

```bash
kubectl exec deploy/app -c app -n default -- \
  curl -sS "http://192.168.30.50/rpc/KVS.GetMany?keys=[\"mode\"]"
```

**Step 2: Apply the mode gate**

The response will show the current mode. Match against the policy:

| Mode reported | Policy (default) | Action |
|---|---|---|
| `idle` | Auto-reboot safe | Proceed to Step 3 |
| `solar_charging` | **Do NOT auto-reboot** | Send push notification and stop |
| `greenhouse_heating` | **Do NOT auto-reboot** | Send push notification and stop |
| `active_drain` | **Do NOT auto-reboot** | Send push notification and stop |

When the mode is NOT idle, the valve state is non-trivial and an unexpected reboot could strand valves open or closed. **Send a push notification describing the situation and stop. A human must act.**

Two alternative policies (not default):
- `POLICY=unconditional` — always reboot regardless of mode (risky: can strand valves mid-transition)
- `POLICY=notify-only` — always just notify, never auto-reboot

**Step 3: Auto-reboot when idle**

Only when the mode is confirmed `idle`:

```bash
kubectl exec deploy/app -c app -n default -- \
  curl -sS -X POST http://192.168.30.50/rpc/Shelly.Reboot
```

Wait 30 seconds, then verify the script restarted:

```bash
kubectl exec deploy/app -c app -n default -- node -e "
  const db = require('./server/lib/db');
  db.pool.query(
    'SELECT id, created_at, error_msg FROM script_crashes ORDER BY created_at DESC LIMIT 2'
  ).then(r => console.log(JSON.stringify(r.rows, null, 2))).catch(e => console.error(e));
"
```

If the crash count increased after reboot, the script is in a crash loop. Note the new error message and **stop auto-remediation**. Send a detailed push notification and open a GitHub issue.

---

## After remediation

### Open a draft GitHub PR for root-cause fix

Based on the incident type:
- OOM: bound `ml-trainer.js` window further or cap the feature set
- OpenVPN cipher: add the appropriate `--allow-deprecated-*` flag to `deploy/docker/openvpn/Dockerfile`
- Script crash-loop: investigate the error message in `script_crashes` table; likely a Shelly firmware update changed a builtin or a timer limit was hit (see `shelly/lint/` SH-014 list)

### Send PWA push summary

Include in the push notification:
- What incident was detected and when
- What action was taken (or not taken, and why)
- Current system status (health endpoint result, mode)
- Link to `/#status` in the playground

Include the cloud environment session URL so the operator can review the full transcript.

---

## Guardrails

### Cooldown

Do not repeat the same remediation action (identified by `kind`) within **30 minutes**. If the same event fires within 30 minutes of a prior remediation, send a notification describing the recurrence but take no automated action.

### Action budget

Maximum **3 automated actions per 60-minute window**. After 3, notify the operator and stop. Record action timestamps in the session scratchpad.

### Kill switch

Before any action, check for a `responder-paused` signal (this can be a file in the home directory, a KV store entry, or an environment variable set by the operator). If the signal is set:
- Skip all automated actions
- Send a push notification that the routine fired but was paused
- Log the reason and stop

To pause: `touch ~/responder-paused` in the cloud environment, or set `RESPONDER_PAUSED=1` in the environment.
To resume: `rm ~/responder-paused`.

---

## Future hook points (not yet implemented)

The following event types will be wired into `routine-trigger.fire()` in future PRs; the runbook will be updated when they are:

- **Notification overheat** — too many push notifications in a short window (anomaly manager or push module emits the event)
- **Anomaly-manager watchdog** — the anomaly manager detects stagnation, overcooling, or sensor dropout and escalates via routine trigger
- **Tank temperature anomaly** — measured temperature diverges from the forecast model by more than the alert threshold
