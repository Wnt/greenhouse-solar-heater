'use strict';

/**
 * Parse an optional `tu` query parameter from a forecast request URL.
 *
 * The Tuning-thresholds forecast preview asks the engine for a what-if
 * projection — "what would the forecast look like with these thresholds"
 * — without saving the values to the device. It passes the candidate
 * tuning map as `?tu=<json>`; both forecast engines run with it instead
 * of the live device-config tuning.
 *
 * Returns:
 *   - null  when no `tu` param is present (→ use live device-config tuning)
 *           or the value is unparseable (graceful fallback to the live forecast)
 *   - a clamped sparse short-key map (possibly {}) when one is present.
 *     {} is meaningful: "every threshold at its firmware default".
 *
 * Values are clamped to TUNING_RANGES so the preview matches what the
 * device would actually run after server-side clamping on save.
 */

const { TUNING_RANGES } = require('../device-config');

function parseTuningOverride(reqUrl) {
  let raw;
  try {
    raw = new URL(reqUrl, 'http://localhost').searchParams.get('tu');
  } catch (e) {
    return null;
  }
  if (raw === null) return null;

  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;

  const out = {};
  Object.keys(TUNING_RANGES).forEach(function (k) {
    const v = obj[k];
    if (typeof v === 'number' && isFinite(v)) {
      const r = TUNING_RANGES[k];
      out[k] = v < r.min ? r.min : (v > r.max ? r.max : v);
    }
  });
  return out;
}

module.exports = { parseTuningOverride };
