'use strict';

/**
 * Forecast algorithm version — a stable identifier for the code that
 * produced a given prediction.
 *
 * Computed once at module load by sha256-hashing the contents of every
 * file in this directory recursively, plus a short list of "extra
 * sources" that materially affect predictions but live outside this
 * directory:
 *
 *   - shelly/control-logic.js   — DEFAULT_CONFIG thresholds feed the
 *                                 forecast engine's hysteresis (geT,
 *                                 ehE, gmD, etc. when no `tu` override
 *                                 is set), so changes there shift the
 *                                 projection even though no file in
 *                                 server/lib/forecast/ changed.
 *   - server/lib/energy-balance.js — tankStoredEnergyKwh() drives the
 *                                 "Tank stores ~X kWh" notes; shared
 *                                 with notifications.js so it can't
 *                                 live inside this dir.
 *
 * Files are sorted by absolute path before hashing so the digest is
 * deterministic regardless of fs.readdir ordering.
 *
 * The 8-char prefix of the digest is exposed as ALGORITHM_VERSION;
 * collisions over our project's lifetime are negligible (sha256
 * collision probability for 8 hex chars ≈ 2^-32 — fine for an audit
 * marker). Persisted with each captured prediction so an operator can
 * tell which version of the code produced a given row when tuning.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

// Files outside this directory that nonetheless gate prediction output.
// Adding a new entry here is the explicit lever for "I changed something
// shared and want a version bump"; the directory walk handles everything
// internal automatically.
const EXTRA_SOURCES = [
  path.join(REPO_ROOT, 'shelly', 'control-logic.js'),
  path.join(REPO_ROOT, 'server', 'lib', 'energy-balance.js'),
];

function walk(dir) {
  const out = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push.apply(out, walk(p));
    } else if (e.isFile()) {
      out.push(p);
    }
  }
  return out;
}

function compute(dir, extras) {
  const files = walk(dir).concat(extras || []).slice();
  files.sort();
  const hash = crypto.createHash('sha256');
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    // Hash the relative path + null + content + null. The path bytes
    // make a rename-only diff produce a different digest, which is
    // what we want — moving forecast/handler.js to forecast/sub/handler.js
    // is a meaningful change even if the content is identical.
    hash.update(path.relative(REPO_ROOT, f));
    hash.update('\0');
    hash.update(fs.readFileSync(f));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 8);
}

const ALGORITHM_VERSION = compute(__dirname, EXTRA_SOURCES);

module.exports = {
  ALGORITHM_VERSION,
  // Exported for tests so they can compute a version with a controlled
  // file set without depending on the live tree.
  _compute: compute,
  _EXTRA_SOURCES: EXTRA_SOURCES,
};
