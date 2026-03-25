/**
 * Shelly HTTP RPC client for browser.
 * Polls DS18B20 sensors from a Shelly device with sensor add-on.
 * Controls valves via Shelly Pro 4PM script (Script.Eval).
 *
 * Routes requests through a local proxy server (/api/rpc/*) to avoid
 * CORS issues — Shelly devices don't send CORS headers.
 */

export class ShellyAPI {
  constructor(sensorDeviceIp) {
    this.sensorDeviceIp = sensorDeviceIp;
    this.timeout = 5000;
  }

  setDeviceIp(ip) {
    this.sensorDeviceIp = ip;
  }

  /**
   * Call a Shelly RPC method via the local proxy (uses default sensorDeviceIp).
   * @param {string} method - RPC method name (e.g. 'Temperature.GetStatus')
   * @param {object} params - Query parameters
   * @returns {Promise<object>} Parsed JSON response
   */
  async rpc(method, params = {}) {
    return this.rpcTo(this.sensorDeviceIp, method, params);
  }

  /**
   * Call a Shelly RPC method on a specific device via the local proxy.
   * @param {string} host - Device IP address
   * @param {string} method - RPC method name
   * @param {object} params - Query parameters
   * @returns {Promise<object>} Parsed JSON response
   */
  async rpcTo(host, method, params = {}) {
    const url = `/api/rpc/${method}`;
    const body = JSON.stringify({ _host: host, ...params });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'greenhouse-monitor',
        },
        body,
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Read a single DS18B20 temperature sensor.
   * @param {number} id - Sensor index (0-based)
   * @returns {Promise<{tC: number, tF: number, id: number}>}
   */
  async getTemperature(id) {
    return this.rpc('Temperature.GetStatus', { id });
  }

  /**
   * Read all configured sensors (tries ids 0..maxId).
   * @param {number[]} sensorIds - Array of sensor IDs to poll
   * @returns {Promise<Array<{id: number, tC: number|null, error: string|null}>>}
   */
  async getAllTemperatures(sensorIds) {
    const results = await Promise.allSettled(
      sensorIds.map(id => this.getTemperature(id))
    );
    return results.map((r, i) => {
      if (r.status === 'fulfilled') {
        return { id: sensorIds[i], tC: r.value.tC, error: null };
      }
      return { id: sensorIds[i], tC: null, error: r.reason.message };
    });
  }

  /**
   * Get device info (useful for connection test).
   * @returns {Promise<object>}
   */
  async getDeviceInfo() {
    return this.rpc('Shelly.GetDeviceInfo');
  }

  /**
   * Get full device status.
   * @returns {Promise<object>}
   */
  async getStatus() {
    return this.rpc('Shelly.GetStatus');
  }

  // ── Valve control (via Pro 4PM script) ──

  /**
   * Evaluate code on a Shelly script via Script.Eval.
   * @param {string} host - Device IP (e.g. Pro 4PM)
   * @param {number} scriptId - Script slot ID
   * @param {string} code - JavaScript expression to evaluate
   * @returns {Promise<object>} Parsed result from the script
   */
  async evalScript(host, scriptId, code) {
    const raw = await this.rpcTo(host, 'Script.Eval', { id: scriptId, code });
    if (raw && raw.result !== undefined) {
      return JSON.parse(raw.result);
    }
    throw new Error('Invalid Script.Eval response');
  }

  /**
   * Get valve status + temps from the Pro 4PM control script.
   * @param {string} host - Pro 4PM IP
   * @param {number} scriptId - Script slot ID (default 1)
   * @returns {Promise<object>} Status object with temps, valves, override, cooldowns
   */
  async getValveStatus(host, scriptId = 1) {
    return this.evalScript(host, scriptId, 'getStatus()');
  }

  /**
   * Set manual valve override on the Pro 4PM script.
   * @param {string} host - Pro 4PM IP
   * @param {number} scriptId - Script slot ID
   * @param {boolean} v1 - Valve 1 desired state (true = open/powered)
   * @param {boolean} v2 - Valve 2 desired state (true = open/powered)
   * @returns {Promise<object>} Confirmation with override state
   */
  async setValveOverride(host, scriptId, v1, v2) {
    return this.evalScript(host, scriptId, 'setOverride(' + v1 + ',' + v2 + ')');
  }

  /**
   * Clear manual override — return to automatic temperature-based control.
   * @param {string} host - Pro 4PM IP
   * @param {number} scriptId - Script slot ID
   * @returns {Promise<object>} Confirmation
   */
  async clearValveOverride(host, scriptId) {
    return this.evalScript(host, scriptId, 'clearOverride()');
  }
}
