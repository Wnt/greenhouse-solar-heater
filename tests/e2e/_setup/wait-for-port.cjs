'use strict';

// Resolve once nothing is listening on host:port, or reject after
// timeoutMs. start.cjs uses this to defer binding 1883/3220 until a
// slow-to-die predecessor harness has released the ports — otherwise
// the fresh boot races the old process and crashes with EADDRINUSE.
//
// "Free" is detected by a probe connection being refused (ECONNREFUSED).
// A successful connect — or a probe that hangs — means something is
// still bound, so we retry until the deadline.

const net = require('net');

function waitForPortFree(port, host, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    function probe() {
      const sock = net.connect({ port, host });
      let settled = false;
      function finish(isFree) {
        if (settled) return;
        settled = true;
        sock.destroy();
        if (isFree) { resolve(); return; }
        if (Date.now() >= deadline) {
          reject(new Error('port ' + port + ' on ' + host + ' still in use after ' + timeoutMs + 'ms'));
          return;
        }
        setTimeout(probe, 200);
      }
      sock.once('connect', function () { finish(false); });
      sock.once('error', function () { finish(true); });
      sock.setTimeout(1000, function () { finish(false); });
    }
    probe();
  });
}

module.exports = { waitForPortFree };
