// Shared mode/watchdog identifiers. Single source of truth so the
// device-config validator, ws-command handlers, and config-events
// audit diff agree on the legal set.

const VALID_MODES = ['I', 'SC', 'GH', 'AD', 'EH'];
const WATCHDOG_IDS = ['sng', 'scs', 'ggr'];

module.exports = { VALID_MODES, WATCHDOG_IDS };
