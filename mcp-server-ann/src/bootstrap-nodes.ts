import { getCachedBootstrapMultiaddrs } from './bootstrap-registry.js';

export const OFFICIAL_ANN_BOOTSTRAP_NODES = [
  '/ip4/8.134.127.201/tcp/41230/ws/p2p/12D3KooWBtrKgF9kRsP6pZNzZZcofBGEjzGzDXivfs5ozKLGM126'
];

// Volunteers can add stable public bootstrap nodes here through a pull request.
// Requirements: websocket transport, persistent PeerID, and a publicly reachable
// TCP port opened in the server firewall/security group.
export const COMMUNITY_ANN_BOOTSTRAP_NODES: string[] = [];

export const PUBLIC_LIBP2P_BOOTSTRAP_NODES = [
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDuVkcruPhmqnQQxgqPtdVj2GZStN5GvSBAyQ7AWT',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa'
];

function splitBootstrapEnv(value?: string): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map(node => node.trim())
    .filter(Boolean);
}

function uniqueNodes(nodes: string[]): string[] {
  return Array.from(new Set(nodes));
}

export function resolveBootstrapNodes(): string[] {
  const configuredNodes = splitBootstrapEnv(process.env.ANN_BOOTSTRAP_NODES);

  if (process.env.ANN_BOOTSTRAP_REPLACE_DEFAULTS === 'true') {
    return uniqueNodes(configuredNodes);
  }

  return uniqueNodes([
    ...configuredNodes,
    ...OFFICIAL_ANN_BOOTSTRAP_NODES,
    ...COMMUNITY_ANN_BOOTSTRAP_NODES,
    ...getCachedBootstrapMultiaddrs(),
    ...PUBLIC_LIBP2P_BOOTSTRAP_NODES
  ]);
}
