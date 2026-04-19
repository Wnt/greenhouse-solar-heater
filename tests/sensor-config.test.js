const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

describe('sensor-config', () => {
  let sensorConfig;
  let tmpDir;
  let configPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sensor-config-test-'));
    configPath = path.join(tmpDir, 'sensor-config.json');

    delete process.env.S3_ENDPOINT;
    delete process.env.S3_BUCKET;
    delete process.env.S3_ACCESS_KEY_ID;
    delete process.env.S3_SECRET_ACCESS_KEY;
    process.env.SENSOR_CONFIG_PATH = configPath;
    process.env.SENSOR_HOST_IPS = '192.168.30.20,192.168.30.21';

    delete require.cache[require.resolve('../server/lib/sensor-config.js')];
    sensorConfig = require('../server/lib/sensor-config.js');
    sensorConfig._reset();
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch (e) {}
    delete process.env.SENSOR_CONFIG_PATH;
    delete process.env.SENSOR_HOST_IPS;
  });

  describe('default config', () => {
    it('builds hosts from SENSOR_HOST_IPS', () => {
      const config = sensorConfig.buildDefaultConfig();
      assert.equal(config.hosts.length, 2);
      assert.equal(config.hosts[0].ip, '192.168.30.20');
      assert.equal(config.hosts[0].id, 'sensor_1');
      assert.equal(config.hosts[1].ip, '192.168.30.21');
      assert.equal(config.hosts[1].id, 'sensor_2');
      assert.deepStrictEqual(config.assignments, {});
      assert.equal(config.version, 0);
    });

    it('handles empty SENSOR_HOST_IPS', () => {
      process.env.SENSOR_HOST_IPS = '';
      delete require.cache[require.resolve('../server/lib/sensor-config.js')];
      const fresh = require('../server/lib/sensor-config.js');
      fresh._reset();
      const config = fresh.buildDefaultConfig();
      assert.equal(config.hosts.length, 0);
    });
  });

  describe('load/save', () => {
    it('returns default config when no file exists', (t, done) => {
      sensorConfig.load(function (err, config) {
        assert.ifError(err);
        assert.equal(config.hosts.length, 2);
        assert.deepStrictEqual(config.assignments, {});
        assert.equal(config.version, 0);
        done();
      });
    });

    it('persistence round-trip works', (t, done) => {
      sensorConfig.load(function (err) {
        assert.ifError(err);
        const assignments = {
          collector: { addr: '40:255:100:6:199:204:149:177', hostIndex: 0, componentId: 100 },
        };
        sensorConfig.updateAssignments(assignments, function (err2, config) {
          assert.ifError(err2);
          assert.equal(config.version, 1);

          // Reload from disk
          sensorConfig._reset();
          delete require.cache[require.resolve('../server/lib/sensor-config.js')];
          const fresh = require('../server/lib/sensor-config.js');
          fresh._reset();
          process.env.SENSOR_CONFIG_PATH = configPath;
          fresh.load(function (err3, loaded) {
            assert.ifError(err3);
            assert.equal(loaded.assignments.collector.addr, '40:255:100:6:199:204:149:177');
            assert.equal(loaded.version, 1);
            done();
          });
        });
      });
    });
  });

  describe('validation', () => {
    const hosts = [{ id: 'sensor_1', ip: '192.168.30.20' }, { id: 'sensor_2', ip: '192.168.30.21' }];

    it('accepts valid assignments', () => {
      const assignments = {
        collector: { addr: '40:255:100:6:199:204:149:177', hostIndex: 0, componentId: 100 },
        tank_top: { addr: '40:255:100:6:199:204:149:178', hostIndex: 0, componentId: 101 },
      };
      assert.equal(sensorConfig.validateAssignments(assignments, hosts), null);
    });

    it('rejects duplicate addresses', () => {
      const assignments = {
        collector: { addr: '40:255:100:6:199:204:149:177', hostIndex: 0, componentId: 100 },
        tank_top: { addr: '40:255:100:6:199:204:149:177', hostIndex: 0, componentId: 101 },
      };
      const err = sensorConfig.validateAssignments(assignments, hosts);
      assert.ok(err);
      assert.ok(err.includes('Duplicate sensor address'));
    });

    it('rejects component ID out of range', () => {
      const assignments = {
        collector: { addr: '40:255:100:6:199:204:149:177', hostIndex: 0, componentId: 5 },
      };
      const err = sensorConfig.validateAssignments(assignments, hosts);
      assert.ok(err);
      assert.ok(err.includes('Component ID must be 100-199'));
    });

    it('rejects invalid host index', () => {
      const assignments = {
        collector: { addr: '40:255:100:6:199:204:149:177', hostIndex: 5, componentId: 100 },
      };
      const err = sensorConfig.validateAssignments(assignments, hosts);
      assert.ok(err);
      assert.ok(err.includes('Invalid host index'));
    });

    it('rejects duplicate component IDs on same host', () => {
      const assignments = {
        collector: { addr: '40:255:100:6:199:204:149:177', hostIndex: 0, componentId: 100 },
        tank_top: { addr: '40:255:100:6:199:204:149:178', hostIndex: 0, componentId: 100 },
      };
      const err = sensorConfig.validateAssignments(assignments, hosts);
      assert.ok(err);
      assert.ok(err.includes('Duplicate component ID'));
    });

    it('allows same component ID on different hosts', () => {
      const assignments = {
        collector: { addr: '40:255:100:6:199:204:149:177', hostIndex: 0, componentId: 100 },
        radiator_in: { addr: '40:255:100:6:199:204:149:182', hostIndex: 1, componentId: 100 },
      };
      assert.equal(sensorConfig.validateAssignments(assignments, hosts), null);
    });

    // Shelly's SensorAddon.OneWireScan returns addresses as colon-separated
    // DECIMAL bytes (e.g. "40:208:87:71:0:0:0:120"), not hex. The leading `40`
    // decimal is 0x28, the DS18B20 family code. The validator must accept
    // values with 1-3 digits per byte in the 0-255 range.
    it('accepts decimal byte format from Shelly OneWireScan', () => {
      const assignments = {
        collector: { addr: '40:208:87:71:0:0:0:120', hostIndex: 0, componentId: 100 },
        tank_top: { addr: '40:255:100:6:199:204:149:177', hostIndex: 0, componentId: 101 },
      };
      assert.equal(sensorConfig.validateAssignments(assignments, hosts), null);
    });

    it('rejects byte values above 255', () => {
      const assignments = {
        collector: { addr: '40:256:87:71:0:0:0:120', hostIndex: 0, componentId: 100 },
      };
      const err = sensorConfig.validateAssignments(assignments, hosts);
      assert.ok(err);
      assert.ok(err.includes('Invalid 1-Wire address format'));
    });

    it('rejects addresses with too few bytes', () => {
      const assignments = {
        collector: { addr: '40:208:87:71:0:0:0', hostIndex: 0, componentId: 100 },
      };
      const err = sensorConfig.validateAssignments(assignments, hosts);
      assert.ok(err);
      assert.ok(err.includes('Invalid 1-Wire address format'));
    });

    it('rejects non-numeric bytes', () => {
      const assignments = {
        collector: { addr: '40:abc:87:71:0:0:0:120', hostIndex: 0, componentId: 100 },
      };
      const err = sensorConfig.validateAssignments(assignments, hosts);
      assert.ok(err);
      assert.ok(err.includes('Invalid 1-Wire address format'));
    });
  });

  describe('getUnassignedRequiredRoles', () => {
    it('returns all required roles when no assignments', () => {
      const missing = sensorConfig.getUnassignedRequiredRoles({});
      assert.deepStrictEqual(missing, ['collector', 'tank_top', 'tank_bottom', 'greenhouse', 'outdoor']);
    });

    it('returns empty when all required roles assigned', () => {
      const assignments = {
        collector: { addr: '40:255:100:6:199:204:149:177' },
        tank_top: { addr: '40:255:100:6:199:204:149:178' },
        tank_bottom: { addr: '40:255:100:6:199:204:149:179' },
        greenhouse: { addr: '40:255:100:6:199:204:149:180' },
        outdoor: { addr: '40:255:100:6:199:204:149:181' },
      };
      const missing = sensorConfig.getUnassignedRequiredRoles(assignments);
      assert.deepStrictEqual(missing, []);
    });
  });

  describe('compact format', () => {
    it('converts to KVS format', () => {
      const config = {
        hosts: [{ id: 'sensor_1', ip: '192.168.30.20' }, { id: 'sensor_2', ip: '192.168.30.21' }],
        assignments: {
          collector: { addr: '40:255:100:6:199:204:149:177', hostIndex: 0, componentId: 100 },
          radiator_in: { addr: '40:255:100:6:199:204:149:182', hostIndex: 1, componentId: 100 },
        },
        version: 3,
      };
      const compact = sensorConfig.toCompactFormat(config);
      assert.deepStrictEqual(compact.h, ['192.168.30.20', '192.168.30.21']);
      assert.deepStrictEqual(compact.s.collector, { h: 0, i: 100, a: '40:255:100:6:199:204:149:177' });
      assert.deepStrictEqual(compact.s.radiator_in, { h: 1, i: 100, a: '40:255:100:6:199:204:149:182' });
      assert.equal(compact.v, 3);
    });

    it('fits within Shelly KVS budget (1024 bytes) with 7 realistic-addr sensors', () => {
      // Real 1-Wire addresses are ~25 chars (decimal bytes, colon-separated)
      // — including them so SensorAddon.AddPeripheral can bind specific
      // probes pushes us past the old 256-byte device-config budget. Shelly
      // KVS accepts ~2400 bytes per value, so 1024 is a safe ceiling.
      const config = {
        hosts: [{ id: 'sensor_1', ip: '192.168.30.20' }, { id: 'sensor_2', ip: '192.168.30.21' }],
        assignments: {
          collector:    { addr: '40:208:87:71:0:0:0:120', hostIndex: 0, componentId: 100 },
          tank_top:     { addr: '40:171:89:71:0:0:0:186', hostIndex: 0, componentId: 101 },
          tank_bottom:  { addr: '40:190:23:71:0:0:0:65',  hostIndex: 0, componentId: 102 },
          greenhouse:   { addr: '40:52:155:84:0:0:0:62',  hostIndex: 0, componentId: 103 },
          outdoor:      { addr: '40:77:248:69:0:0:0:216', hostIndex: 0, componentId: 104 },
          radiator_in:  { addr: '40:255:100:6:199:204:149:182', hostIndex: 1, componentId: 100 },
          radiator_out: { addr: '40:255:100:6:199:204:149:183', hostIndex: 1, componentId: 101 },
        },
        version: 1,
      };
      const compact = sensorConfig.toCompactFormat(config);
      const json = JSON.stringify(compact);
      assert.ok(json.length <= 1024, 'Compact format is ' + json.length + ' bytes, exceeds 1024');
    });
  });

  describe('MQTT-based apply', () => {
    it('applyConfig uses mqttBridge.publishSensorConfigApply', (t, done) => {
      sensorConfig.load(function (err) {
        assert.ifError(err);
        const mockBridge = {
          publishSensorConfigApply: function (request) {
            assert.ok(request.id.startsWith('apply-'));
            assert.equal(request.target, null);
            assert.ok(request.config.h);
            assert.ok(request.config.s !== undefined);
            return Promise.resolve({
              id: request.id,
              success: true,
              results: [
                { host: '192.168.30.20', ok: true, peripherals: 2 },
                { host: '192.168.30.21', ok: true, peripherals: 1 },
              ],
            });
          },
          publishSensorConfig: function () { return true; },
        };
        sensorConfig.applyConfig(mockBridge, function (err, results) {
          assert.ifError(err);
          assert.equal(results.sensor_1.status, 'success');
          assert.equal(results.sensor_2.status, 'success');
          assert.equal(results.control.status, 'success');
          done();
        });
      });
    });

    it('applyConfig returns error when MQTT bridge not available', (t, done) => {
      sensorConfig.load(function (err) {
        assert.ifError(err);
        sensorConfig.applyConfig(null, function (err) {
          assert.ok(err);
          assert.ok(err.message.includes('MQTT bridge not available'));
          done();
        });
      });
    });

    it('applyConfig returns error on MQTT timeout', (t, done) => {
      sensorConfig.load(function (err) {
        assert.ifError(err);
        const mockBridge = {
          publishSensorConfigApply: function () {
            return Promise.reject(new Error('Request timed out'));
          },
        };
        sensorConfig.applyConfig(mockBridge, function (err) {
          assert.ok(err);
          assert.equal(err.message, 'Request timed out');
          done();
        });
      });
    });

    it('applySingleTarget routes control target via publishSensorConfig', (t, done) => {
      sensorConfig.load(function (err) {
        assert.ifError(err);
        let published = false;
        const mockBridge = {
          publishSensorConfig: function () { published = true; return true; },
        };
        sensorConfig.applySingleTarget('control', mockBridge, function (err, results) {
          assert.ifError(err);
          assert.equal(results.control.status, 'success');
          assert.ok(published);
          done();
        });
      });
    });

    it('applySingleTarget routes host target via MQTT', (t, done) => {
      sensorConfig.load(function (err) {
        assert.ifError(err);
        const mockBridge = {
          publishSensorConfigApply: function (request) {
            assert.equal(request.target, '192.168.30.20');
            return Promise.resolve({
              id: request.id,
              success: true,
              results: [{ host: '192.168.30.20', ok: true, peripherals: 3 }],
            });
          },
        };
        sensorConfig.applySingleTarget('sensor_1', mockBridge, function (err, results) {
          assert.ifError(err);
          assert.equal(results.sensor_1.status, 'success');
          done();
        });
      });
    });
  });

  describe('HTTP handlers', () => {
    it('GET returns current config', (t, done) => {
      sensorConfig.load(function (err) {
        assert.ifError(err);
        const res = mockResponse();
        sensorConfig.handleGet({}, res);
        const body = JSON.parse(res._body);
        assert.equal(body.hosts.length, 2);
        assert.equal(res._statusCode, 200);
        done();
      });
    });

    it('PUT updates assignments and increments version', (t, done) => {
      sensorConfig.load(function (err) {
        assert.ifError(err);
        const body = JSON.stringify({
          assignments: {
            collector: { addr: '40:255:100:6:199:204:149:177', hostIndex: 0, componentId: 100 },
          },
        });
        const res = mockResponse();
        sensorConfig.handlePut({}, res, body, function (config) {
          assert.equal(config.version, 1);
          assert.equal(config.assignments.collector.addr, '40:255:100:6:199:204:149:177');

          const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
          assert.equal(saved.version, 1);
          done();
        });
      });
    });

    it('PUT rejects invalid JSON', (t, done) => {
      sensorConfig.load(function (err) {
        assert.ifError(err);
        const res = mockResponse();
        sensorConfig.handlePut({}, res, 'not json', null);
        assert.equal(res._statusCode, 400);
        done();
      });
    });

    it('PUT rejects duplicate addresses', (t, done) => {
      sensorConfig.load(function (err) {
        assert.ifError(err);
        const body = JSON.stringify({
          assignments: {
            collector: { addr: '40:255:100:6:199:204:149:177', hostIndex: 0, componentId: 100 },
            tank_top: { addr: '40:255:100:6:199:204:149:177', hostIndex: 0, componentId: 101 },
          },
        });
        const res = mockResponse();
        sensorConfig.handlePut({}, res, body, null);
        assert.equal(res._statusCode, 400);
        const result = JSON.parse(res._body);
        assert.ok(result.error.includes('Duplicate'));
        done();
      });
    });
  });
});

function mockResponse() {
  return {
    _statusCode: 200,
    _headers: {},
    _body: '',
    writeHead: function (code, headers) {
      this._statusCode = code;
      this._headers = headers || {};
    },
    end: function (body) {
      this._body = body || '';
    },
  };
}
