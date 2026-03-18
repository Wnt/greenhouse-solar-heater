/**
 * PoC dev server — serves static files and proxies /api/rpc/* to a Shelly device.
 *
 * Usage: node server.js [port]
 *   port defaults to 3000
 *
 * The Shelly device IP is sent by the browser as a query param:
 *   /api/rpc/Temperature.GetStatus?id=0&_host=192.168.1.20
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = parseInt(process.argv[2] || '3000', 10);
const STATIC_DIR = __dirname;

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res) {
  var urlPath = new URL(req.url, 'http://localhost').pathname;
  if (urlPath === '/') urlPath = '/index.html';
  var filePath = path.join(STATIC_DIR, urlPath);

  // Prevent directory traversal
  if (!filePath.startsWith(STATIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, function (err, data) {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    var ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function proxyRpc(req, res) {
  var parsed = new URL(req.url, 'http://localhost');
  var host = parsed.searchParams.get('_host');
  if (!host) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing _host parameter' }));
    return;
  }

  // Strip /api prefix and _host param, forward to Shelly device
  var rpcPath = parsed.pathname.replace(/^\/api/, '');
  parsed.searchParams.delete('_host');
  var query = parsed.searchParams.toString();
  var shellyUrl = 'http://' + host + rpcPath + (query ? '?' + query : '');

  http.get(shellyUrl, { timeout: 5000 }, function (shellyRes) {
    var body = '';
    shellyRes.on('data', function (chunk) { body += chunk; });
    shellyRes.on('end', function () {
      res.writeHead(shellyRes.statusCode, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(body);
    });
  }).on('error', function (err) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  });
}

var server = http.createServer(function (req, res) {
  if (req.url.startsWith('/api/rpc/')) {
    proxyRpc(req, res);
  } else {
    serveStatic(req, res);
  }
});

function getNetworkAddress() {
  var interfaces = os.networkInterfaces();
  for (var name in interfaces) {
    var addrs = interfaces[name];
    for (var i = 0; i < addrs.length; i++) {
      if (addrs[i].family === 'IPv4' && !addrs[i].internal) {
        return addrs[i].address;
      }
    }
  }
  return null;
}

function printBanner(port, networkIp) {
  var local = 'http://localhost:' + port;
  var network = networkIp ? 'http://' + networkIp + ':' + port : null;

  var lines = [
    '',
    '   Serving!',
    '',
    '   - Local:    ' + local,
  ];
  if (network) {
    lines.push('   - Network:  ' + network);
  }
  lines.push('');

  var maxLen = 0;
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].length > maxLen) maxLen = lines[i].length;
  }
  var width = maxLen + 4;

  console.log('');
  console.log('   \u250c' + '\u2500'.repeat(width) + '\u2510');
  for (var j = 0; j < lines.length; j++) {
    var padded = lines[j] + ' '.repeat(width - lines[j].length);
    console.log('   \u2502' + padded + '\u2502');
  }
  console.log('   \u2514' + '\u2500'.repeat(width) + '\u2518');
  console.log('');
}

server.listen(PORT, '0.0.0.0', function () {
  printBanner(PORT, getNetworkAddress());
});
