/**
 * YAML Loader — parses system.yaml and extracts configuration for simulators.
 * Uses js-yaml loaded via importmap.
 */

let _cachedConfig = null;

export async function loadSystemYaml(path = '../system.yaml') {
  if (_cachedConfig) return _cachedConfig;

  const resp = await fetch(path);
  if (!resp.ok) throw new Error(`Failed to load system.yaml: ${resp.status}`);
  const text = await resp.text();

  const { load } = await import('js-yaml');
  const raw = load(text);

  _cachedConfig = extractConfig(raw);
  return _cachedConfig;
}

function extractConfig(raw) {
  const modes = {};
  for (const [name, mode] of Object.entries(raw.modes || {})) {
    modes[name] = {
      description: mode.description || '',
      trigger: mode.trigger || null,
      exit: mode.exit || null,
      minimum_run_time: mode.minimum_run_time || null,
      resume_condition: mode.resume_condition || null,
      valve_states: mode.valve_states || {},
      actuators: mode.actuators || {},
      sequence: mode.sequence || null,
    };
  }

  const valves = {};
  const manifolds = ['input_manifold', 'output_manifold', 'collector_top'];
  for (const m of manifolds) {
    const section = raw.valves?.[m] || {};
    for (const [key, val] of Object.entries(section)) {
      if (typeof val === 'object' && val.type) {
        valves[key] = { ...val, manifold: m };
      }
    }
  }

  const sensors = {};
  for (const [key, val] of Object.entries(raw.sensors || {})) {
    sensors[key] = { ...val };
  }

  const components = raw.components || {};
  const safety = raw.safety || [];
  const project = raw.project || {};

  return { modes, valves, sensors, components, safety, project, raw };
}

/** Parse a trigger string like "t_collector > t_tank_bottom + 7°C" */
export function parseTrigger(triggerStr) {
  if (!triggerStr) return null;
  // Simple pattern: sensor op sensor|value [+/- offset]
  const parts = triggerStr.split(/\s+AND\s+/i);
  return parts.map(part => {
    const m = part.match(/(\w+)\s*([<>!=]+)\s*(\w+)(?:\s*([+-])\s*([\d.]+))?/);
    if (!m) return { raw: part };
    return {
      left: m[1],
      op: m[2],
      right: m[3],
      offset_sign: m[4] || null,
      offset_value: m[5] ? parseFloat(m[5]) : 0,
      raw: part,
    };
  });
}

export function evaluateTrigger(conditions, sensorValues) {
  if (!conditions) return false;
  return conditions.every(cond => {
    if (!cond.left) return false;
    const left = sensorValues[cond.left];
    if (left === undefined) return false;

    let right;
    const numRight = parseFloat(cond.right);
    right = isNaN(numRight) ? (sensorValues[cond.right] ?? 0) : numRight;

    if (cond.offset_sign === '+') right += cond.offset_value;
    if (cond.offset_sign === '-') right -= cond.offset_value;

    switch (cond.op) {
      case '>': return left > right;
      case '<': return left < right;
      case '>=': return left >= right;
      case '<=': return left <= right;
      case '==': return left === right;
      default: return false;
    }
  });
}
