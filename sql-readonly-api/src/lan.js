'use strict';

const net = require('node:net');

/** True for loopback, private (RFC 1918), link-local and IPv6 ULA addresses. */
function isLanAddress(address) {
  if (!address) return false;
  let ip = address;
  if (ip.startsWith('::ffff:')) ip = ip.slice(7); // IPv4-mapped IPv6

  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    return lower === '::1' || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower);
  }
  return false;
}

module.exports = { isLanAddress };
