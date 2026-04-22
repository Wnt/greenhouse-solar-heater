// Startup banner + network-address helper. Extracted from server.js.

const os = require('os');

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

  var lines = ['', '   Serving!', '', '   - Local:    ' + local];
  if (network) lines.push('   - Network:  ' + network);
  lines.push('');

  var maxLen = 0;
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].length > maxLen) maxLen = lines[i].length;
  }
  var width = maxLen + 4;
  console.log('');
  console.log('   ┌' + '─'.repeat(width) + '┐');
  for (var j = 0; j < lines.length; j++) {
    var padded = lines[j] + ' '.repeat(width - lines[j].length);
    console.log('   │' + padded + '│');
  }
  console.log('   └' + '─'.repeat(width) + '┘');
  console.log('');
}

module.exports = { getNetworkAddress, printBanner };
