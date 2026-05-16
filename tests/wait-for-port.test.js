const { describe, it } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');

const { waitForPortFree } = require('./e2e/_setup/wait-for-port.cjs');

// A port unlikely to collide with the dev servers (3210/3220) or the
// e2e MQTT broker (1883).
const TEST_PORT = 39517;
const HOST = '127.0.0.1';

describe('waitForPortFree', () => {
  it('resolves immediately when the port is already free', async () => {
    await waitForPortFree(TEST_PORT, HOST, 2000);
  });

  it('rejects when the port stays occupied past the timeout', async () => {
    const server = net.createServer();
    await new Promise((resolve) => server.listen(TEST_PORT, HOST, resolve));
    try {
      await assert.rejects(
        waitForPortFree(TEST_PORT, HOST, 600),
        /still in use/,
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('resolves once an occupied port is released mid-wait', async () => {
    const server = net.createServer();
    await new Promise((resolve) => server.listen(TEST_PORT, HOST, resolve));
    // Release the port shortly after the wait begins — mirrors a
    // predecessor harness finishing its shutdown.
    setTimeout(() => server.close(), 300);
    await waitForPortFree(TEST_PORT, HOST, 5000);
  });
});
