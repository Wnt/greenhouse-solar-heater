// Startup banner + network-address helper. Extracted from server.js.

const os = require('os');

function getNetworkAddress() {
  const interfaces = os.networkInterfaces();
  for (const name in interfaces) {
    const addrs = interfaces[name];
    for (let i = 0; i < addrs.length; i++) {
      if (addrs[i].family === 'IPv4' && !addrs[i].internal) {
        return addrs[i].address;
      }
    }
  }
  return null;
}

function printBanner(port, networkIp) {
  const local = 'http://localhost:' + port;
  const network = networkIp ? 'http://' + networkIp + ':' + port : null;

  const lines = ['', '   Serving!', '', '   - Local:    ' + local];
  if (network) lines.push('   - Network:  ' + network);
  lines.push('');

  let maxLen = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].length > maxLen) maxLen = lines[i].length;
  }
  const width = maxLen + 4;
  console.log('');
  console.log('   ┌' + '─'.repeat(width) + '┐');
  for (let j = 0; j < lines.length; j++) {
    const padded = lines[j] + ' '.repeat(width - lines[j].length);
    console.log('   │' + padded + '│');
  }
  console.log('   └' + '─'.repeat(width) + '┘');
  console.log('');
}

module.exports = { getNetworkAddress, printBanner };
