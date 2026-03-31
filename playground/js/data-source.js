/**
 * Data source abstraction for the playground.
 * Provides SimulationSource (local physics model) and LiveSource (WebSocket).
 * Both produce the same data shape consumed by updateDisplay(state, result).
 */

// ── Base interface ──

class DataSource {
  constructor() {
    this._updateCallbacks = [];
    this._connectionCallbacks = [];
    this.connected = false;
    this.lastUpdate = 0;
  }

  onUpdate(callback) {
    this._updateCallbacks.push(callback);
  }

  onConnectionChange(callback) {
    this._connectionCallbacks.push(callback);
  }

  _emitUpdate(state, result) {
    this.lastUpdate = Date.now();
    for (const cb of this._updateCallbacks) {
      cb(state, result);
    }
  }

  _emitConnectionChange(status) {
    this.connected = status === 'connected';
    for (const cb of this._connectionCallbacks) {
      cb(status);
    }
  }

  start() {}
  stop() {}
}

// ── LiveSource: WebSocket connection to server ──

export class LiveSource extends DataSource {
  constructor(wsUrl) {
    super();
    this.wsUrl = wsUrl || LiveSource.defaultWsUrl();
    this.ws = null;
    this._reconnectTimer = null;
    this._reconnectDelay = 1000;
    this.hasReceivedData = false;
    this.mqttStatus = 'unknown';
    this._connectedAt = 0;
  }

  static defaultWsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return proto + '//' + location.host + '/ws';
  }

  start() {
    this._connect();
  }

  stop() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onclose = null; // prevent reconnect
      this.ws.close();
      this.ws = null;
    }
    this.hasReceivedData = false;
    this.mqttStatus = 'unknown';
    this._connectedAt = 0;
    this._emitConnectionChange('disconnected');
  }

  _connect() {
    if (this.ws) return;

    try {
      this.ws = new WebSocket(this.wsUrl);
    } catch (e) {
      this._scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this._reconnectDelay = 1000;
      this.mqttStatus = 'unknown';
      this._connectedAt = Date.now();
      this._emitConnectionChange('connected');
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'state') {
          this._handleState(msg.data);
        } else if (msg.type === 'connection') {
          // Server's MQTT connection status — track separately from WS
          this.mqttStatus = msg.status;
          // Notify listeners to re-evaluate display state (WS status unchanged)
          for (const cb of this._connectionCallbacks) {
            cb(this.connected ? 'connected' : 'disconnected');
          }
        }
      } catch (e) {
        // ignore parse errors
      }
    };

    this.ws.onclose = () => {
      this.ws = null;
      this.mqttStatus = 'unknown';
      this._emitConnectionChange('disconnected');
      this._scheduleReconnect();
    };

    this.ws.onerror = () => {
      // onclose will fire after onerror
    };
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    this._emitConnectionChange('reconnecting');
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._reconnectDelay = Math.min(this._reconnectDelay * 2, 30000);
      this._connect();
    }, this._reconnectDelay);
  }

  _handleState(data) {
    this.hasReceivedData = true;
    // Map MQTT state snapshot to playground's internal format
    const state = {
      t_collector: data.temps ? data.temps.collector : null,
      t_tank_top: data.temps ? data.temps.tank_top : null,
      t_tank_bottom: data.temps ? data.temps.tank_bottom : null,
      t_greenhouse: data.temps ? data.temps.greenhouse : null,
      t_outdoor: data.temps ? data.temps.outdoor : null,
      simTime: 0, // Not applicable in live mode
    };

    const result = {
      mode: data.mode || 'idle',
      valves: data.valves || {},
      actuators: data.actuators || {},
      transition: data.transitioning ? (data.transition_step || 'transitioning') : null,
      transitioning: data.transitioning || false,
      transition_step: data.transition_step || null,
      controls_enabled: data.controls_enabled,
    };

    this._emitUpdate(state, result);
  }
}

// ── SimulationSource: wraps existing ThermalModel + ControlStateMachine ──

export class SimulationSource extends DataSource {
  constructor() {
    super();
    this.connected = true; // simulation is always "connected"
  }

  start() {
    this._emitConnectionChange('connected');
  }

  stop() {
    // Simulation lifecycle managed externally by the existing simLoop
  }

  // Called by the existing simLoop to push updates through the data source
  pushUpdate(state, result) {
    this._emitUpdate(state, result);
  }
}

export { DataSource };
