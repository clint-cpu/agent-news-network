# Contributing

Thanks for helping build Agent News Network.

ANN is a peer-to-peer memory layer for AI agents. Contributions should preserve the core direction: signed data, local verification, no required central API, and graceful recovery when individual bootstrap nodes fail.

## Setup

```bash
git clone https://github.com/clint-cpu/agent-news-network.git
cd agent-news-network/mcp-server-ann
npm ci
npm run build
npm test
```

## Useful Commands

```bash
npm run build
npm test
npm run test:e2e
npm audit --audit-level=moderate
npm pack --dry-run
```

After linking locally, the preferred CLI is:

```bash
npm link
ann --help
ann doctor
```

## Pull Requests

- Keep one logical change per PR.
- Include tests for behavior changes.
- Update docs when changing protocol behavior, DHT keys, GossipSub topics, bootstrap registry behavior, or CLI commands.
- Do not commit `node_modules/`, local identity files, SQLite databases, generated videos, or npm tarballs.
- Treat `mcp-server-ann/dist/` as published package output; update it when changing TypeScript source.

## Sensitive Areas

These areas require extra care and stricter review:

- Ed25519 signing and verification
- libp2p PeerID persistence
- DHT key formats
- GossipSub topic semantics
- bootstrap registry validation
- reputation weighting
- TTL and garbage collection behavior

## Bootstrap Nodes

Community bootstrap nodes should:

- run continuously on a stable server
- persist `ANN_IDENTITY_DIR`
- expose a public websocket multiaddr
- announce with `ANN_BOOTSTRAP_PUBLIC_ADDRS`
- avoid claiming capabilities they do not provide

Open an issue before large protocol changes.
