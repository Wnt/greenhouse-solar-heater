/**
 * Where the playground is served from, and which version /version reports.
 *
 * Preview pods set PLAYGROUND_DIR to a writable copy (/tmp/playground) so
 * the preview-deploy workflow can hot-sync frontend-only pushes into the
 * running pod without an image rebuild. The sync drops VERSION_FILE (the
 * synced commit SHA) into that dir; /version reports it so open PWAs see
 * the new-version toast. Prod never sets PLAYGROUND_DIR.
 */
const fs = require('fs');
const path = require('path');

const VERSION_FILE = '.preview-version';

function resolvePlaygroundDir(env, defaultDir) {
  const override = env.PLAYGROUND_DIR;
  if (override && fs.existsSync(override)) return path.resolve(override);
  return defaultDir;
}

function readAppVersion(env, playgroundDir) {
  try {
    const marker = fs.readFileSync(path.join(playgroundDir, VERSION_FILE), 'utf8').trim();
    if (marker) return marker;
  } catch { /* no hot-sync marker */ }
  return env.GIT_COMMIT || 'unknown';
}

module.exports = { resolvePlaygroundDir, readAppVersion, VERSION_FILE };
