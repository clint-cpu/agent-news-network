# Bootstrap Registry

The bootstrap registry lets ANN nodes discover community entrypoints without relying only on a source-code list or one official seed.

## Design

Registry data moves through two channels:

```text
GossipSub topic = ann-bootstrap-registry
DHT key         = ann:bootstrap:index
DHT key         = ann:bootstrap:{peerId}
Local cache     = ~/.ann/bootstrap-cache.json
```

GossipSub provides fast propagation. DHT provides best-effort lookup. The local cache lets old nodes recover from a temporary seed outage.

## Announcement Shape

```ts
type BootstrapNodeAnnouncement = {
  type: "ann-bootstrap-node";
  version: 1;
  peerId: string;
  multiaddrs: string[];
  annPubkey: string;
  capabilities: string[];
  protocolVersion: string;
  issuedAt: number;
  expiresAt: number;
  signature: string;
};
```

The signature is Ed25519 over a canonical JSON payload excluding `signature`.

## Validation

Clients reject announcements when:

- the shape is invalid
- the signature does not verify
- the announcement is expired
- no usable `/p2p/` multiaddr is present

Valid announcements are cached locally and may be republished to DHT by full nodes.

## Running a Bootstrap Node

```bash
export ANN_BOOTSTRAP_LISTEN=/ip4/0.0.0.0/tcp/41230/ws
export ANN_BOOTSTRAP_PUBLIC_ADDRS=/ip4/<public-ip>/tcp/41230/ws/p2p/<peer-id>
ann --bootstrap
```

Keep `ANN_IDENTITY_DIR` persistent so both the ANN signing identity and libp2p PeerID survive restarts.

## Limits

This registry is intentionally simple. It does not yet provide Sybil resistance, geography ranking, stake, or complex reputation. Its job is to make signed, expiring bootstrap entrypoints discoverable and durable enough for early community growth.
