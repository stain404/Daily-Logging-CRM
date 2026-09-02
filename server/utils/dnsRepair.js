// Make `mongodb+srv://` resolvable on a machine whose Node points at a dead
// DNS server.
//
// On at least one of the machines these scripts get run from, Node's
// `dns.getServers()` returns ['127.0.0.1'] and nothing is listening there, so
// every SRV lookup dies with `querySrv ECONNREFUSED` before a packet reaches
// Atlas. Windows' own resolver is healthy — `nslookup` on the same hostname
// answers instantly — which makes this read as an Atlas outage or a firewall
// when it is neither.
//
// This matters most for the scripts nobody runs until something has already
// gone wrong. resetPassword.js is the only way back in when the superadmin
// password is lost, and it failed at exactly the moment it was needed.
//
// Only overrides when EVERY configured resolver is loopback. On a healthy
// machine that check is false and this does nothing; on a corporate network
// the local resolver may be the only one that can see internal hosts, and
// replacing it would break more than it fixes.
//
// Usage — require it once, before connecting:
//   const { repairDnsIfLoopback } = require('../utils/dnsRepair');
//   repairDnsIfLoopback();

const dns = require('dns');

const PUBLIC_RESOLVERS = ['1.1.1.1', '8.8.8.8'];

function repairDnsIfLoopback({ quiet = false } = {}) {
  let servers;
  try {
    servers = dns.getServers();
  } catch {
    return null;                       // nothing to inspect, leave it alone
  }

  if (!servers.length) return null;

  const allLoopback = servers.every(
    s => s === '::1' || s.startsWith('127.')
  );
  if (!allLoopback) return null;

  try {
    dns.setServers(PUBLIC_RESOLVERS);
  } catch {
    return null;
  }

  if (!quiet) {
    console.log(`ℹ️   DNS was set to ${servers.join(', ')}, which refuses connections.`);
    console.log(`    Using ${PUBLIC_RESOLVERS.join(' / ')} for this run only.`);
  }
  return servers;
}

module.exports = { repairDnsIfLoopback, PUBLIC_RESOLVERS };
