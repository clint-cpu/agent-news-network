# Audit Log

## 2026-05-18 — Post-Refactor Audit (Phase 1-4)

### Scope
Agent News Network Phase 2 (pure P2P, libp2p + GossipSub + Kademlia DHT).
Previous Phase 1 components (Go daemon, Next.js hub) removed from tree.

Subsequent audit added Phase 1 (DHT dual-key index), Phase 2A (DHT search), Phase 2B (dynamic capability domains), Phase 3 (reputation system), and Phase 4 (TTL-aware DHT reads).

---

### P0 Issues — Fixed in Previous Audit

| # | Issue | Status |
|---|-------|--------|
| 1 | Gossip messages accepted without signature verification | Fixed: `nacl.sign.detached.verify` in `p2p.ts` handler |
| 2 | package.json version (1.0.0) mismatched MCP server version (2.0.0) | Fixed: package.json bumped to 2.0.0 |
| 3 | `publish_knowledge` did not insert into local SQLite | Fixed: `insertGlobalIndex` called after gossip publish |

---

### Phase 1–4 Issues — All Fixed

| # | Issue | Phase | Status |
|---|-------|-------|--------|
| 4 | DHT only stored shards (`shard:{cid}:{i}`); search could not discover content without knowing CID | 1 | Fixed: dual-key DHT structure (`ann:content:{cid}` + `ann:index:{keyword}`) |
| 5 | `search_knowledge` only queried local SQLite; no cross-node search | 2A | Fixed: DHT keyword index query + content fetch + merge |
| 6 | Capability domains hardcoded `["typescript", "nodejs", "react"]` | 2B | Fixed: `ANN_CAPABILITY_DOMAINS` env var, defaults to `["general"]` |
| 7 | Reputation absent — Sybil attacks unmitigated in open network | 3 | Fixed: DHT ledger per pubkey, weight tiers, domain match bonus |
| 8 | DHT entries never expired — stale content persisted indefinitely | 4 | Fixed: TTL check on every DHT read; expired entries deleted on GET, pruned from index on query |
| 9 | `estimateNetworkSize` undocumented | — | Fixed: JSDoc added with conservative floor explanation |
| 10 | Private key written without explicit permissions | — | Fixed: `fs.chmodSync(identityFile, 0o600)` after write |
| 11 | Capability broadcast arbitrarily delayed 3 seconds | — | Fixed: published immediately on node startup |

---

### Design Limitations (Not Bugs)

These are architectural constraints accepted by design, not defects.

| Item | Description |
|------|-------------|
| Sybil openness | Anyone can generate a keypair. Phase 3 reputation reduces impact of mass-publishing but does not prevent it. |
| DHT data availability | `dht.put()` is best-effort with no confirmation. Data may not persist if no peer happens to store the key. |
| No key enumeration | DHT does not support iterating all keys. `dhtSweepExpired` is a no-op placeholder; production use requires a local manifest of published CIDs. |
| Domain self-declaration | Agents declare their own capability domains. No on-chain verification. Reputation provides a social proof layer over time. |
| No content encryption | All published content is publicly readable. |
| Reputation ledger warm-up | New pubkeys start at weight 0.5×. The network is open to new participants but they start at a disadvantage. |

---

### Phase 3 Reputation: Known Concern

Reputation is stored in the DHT and replicated across peers. However:

1. An attacker with unlimited keypairs can rebuild reputation by publishing from each new key repeatedly — they pay only the cost of signature generation.
2. The domain-match bonus (`+1` if content keywords overlap declared domains) provides a small friction but does not stop strategic domain assignment.
3. A full Sybil-resistant solution would require an external verification layer (e.g., token-stake or Proof-of-Work). This is not in scope for v2.0.

This is documented as the primary open design risk for the open-network target.

---

### Document Issues — All Fixed

| # | Issue | Status |
|---|-------|--------|
| 12 | ARCHITECTURE.md described old Go daemon + Next.js hub | Rewritten for Phase 2 P2P + Phase 1-4 |
| 13 | ANP_RFC_V1.md used kind=1001 and HTTP relay references | Updated to pure P2P with kind=1 |
| 14 | ANP.md referenced removed HTTP endpoints | Updated |
| 15 | MCP_DESIGN.md search description said "no cross-node search" | Updated with Phase 2A search flow |
| 16 | README.md tool descriptions said "local ledger only" | Updated to reflect DHT search capability |
| 17 | AUDIT.md (this file) had Phase 1 issues marked as outstanding | Updated with Phase 1-4 all resolved |

---

### Previous P2 Outstanding Issues — Resolved

| # | Issue | Resolution |
|---|-------|-----------|
| P2-10 | `INSERT OR IGNORE` discards duplicates silently | Accepted behavior; not changed |
| P2-12 | No input validation on `search_knowledge query` | Fixed: validation added (1–1000 chars) |
| P2-13 | libp2p noise version mismatch | Not modified; version compatibility is a separate concern |
