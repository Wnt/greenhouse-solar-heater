/**
 * Shelly HTTP RPC client for browser.
 * Polls DS18B20 sensors from a Shelly device with sensor add-on.
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
   * Call a Shelly RPC method via the local proxy.
   * @param {string} method - RPC method name (e.g. 'Temperature.GetStatus')
   * @param {object} params - Query parameters
   * @returns {Promise<object>} Parsed JSON response
   */
  async rpc(method, params = {}) {
    const searchParams = new URLSearchParams({ _host: this.sensorDeviceIp });
    for (const [k, v] of Object.entries(params)) {
      searchParams.set(k, v);
    }
    const url = `/api/rpc/${method}?${searchParams}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const res = await fetch(url, { signal: controller.signal });
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
}
