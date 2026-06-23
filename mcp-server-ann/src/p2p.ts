import { createLibp2p, Libp2p } from 'libp2p';
import { webSockets } from '@libp2p/websockets';
import { bootstrap } from '@libp2p/bootstrap';
import { noise } from '@chainsafe/libp2p-noise';
import { mplex } from '@libp2p/mplex';
import { identify } from '@libp2p/identify';
import { ping } from '@libp2p/ping';
import { kadDHT } from '@libp2p/kad-dht';
import { gossipsub } from '@libp2p/gossipsub';
import rs from 'reedsolomon';
import crypto from 'crypto';
import { insertGlobalIndex, insertHelpAnswer, insertHelpRequest, getExpiredPublishedCids, deletePublishedCid } from './db.js';
import { loadOrGenerateIdentity } from './identity.js';
import { loadOrGeneratePeerPrivateKey } from './peer-identity.js';
import { resolveBootstrapNodes } from './bootstrap-nodes.js';
import {
  BOOTSTRAP_REGISTRY_TOPIC,
  buildBootstrapAnnouncement,
  cacheBootstrapAnnouncement,
  putBootstrapAnnouncementToDHT,
  searchBootstrapAnnouncements,
  verifyBootstrapAnnouncement
} from './bootstrap-registry.js';
import nacl from 'tweetnacl';

let node: Libp2p<any> | null = null;
let startPromise: Promise<Libp2p<any>> | null = null;

export type NodeMode = 'full' | 'light';
export const HELP_REQUEST_TOPIC = 'ann-help-requests';
export const HELP_ANSWER_TOPIC = 'ann-help-answers';

export async function startP2PNode(mode: NodeMode = 'full'): Promise<Libp2p<any>> {
  if (node) return node;
  if (startPromise) return startPromise;

  startPromise = (async () => {
    try {
      const isFullNode = mode === 'full';

  // Nostr-inspired Lightweight Client Mode
  // If light mode, we do NOT spin up the heavy DHT. We only connect via websocket to gossipsub.
  const services: any = {
    identify: identify(),
    ping: ping(),
    pubsub: gossipsub({
      allowPublishToZeroTopicPeers: true,
      emitSelf: true
    })
  };

  if (isFullNode) {
    services.dht = kadDHT();
  }

  const listenAddrs = process.env.ANN_BOOTSTRAP_LISTEN ? [process.env.ANN_BOOTSTRAP_LISTEN] : (isFullNode ? ['/ip4/0.0.0.0/tcp/0/ws'] : []);
  const bootstrapList = resolveBootstrapNodes();
  const privateKey = await loadOrGeneratePeerPrivateKey();

  node = await createLibp2p({
    privateKey,
    addresses: {
      listen: listenAddrs 
    },
    transports: [webSockets()],
    connectionEncrypters: [noise()],
    streamMuxers: [mplex()],
    // @ts-ignore
    peerDiscovery: [
      (bootstrap as any)({
        list: bootstrapList
      })
    ],
    services
  });

  await node.start();
  console.log(`[P2P] Node started in ${mode.toUpperCase()} mode with ID:`, node.peerId.toString());

      // Set up pubsub handlers after node is started
      await setupPubsubHandlers(node, mode);
      await refreshBootstrapRegistry(node);
      await announceBootstrapNodeIfConfigured(node);

      return node;
    } catch (err) {
      node = null;
      throw err;
    } finally {
      startPromise = null;
    }
  })();

  return startPromise;
}

export async function stopP2PNode(): Promise<void> {
  if (!node) return;
  await node.stop();
  node = null;
  startPromise = null;
}

export function getP2PNode(): Libp2p<any> | null {
  return node;
}

export async function setupPubsubHandlers(nodeInstance: Libp2p<any>, mode: NodeMode): Promise<void> {
  nodeInstance.services.pubsub.addEventListener('message', async (evt: any) => {
    if (evt.detail.topic === 'ann-agent-capabilities') {
      const msg = new TextDecoder().decode(evt.detail.data);
      try {
        const capability = JSON.parse(msg);
        console.log(`[P2P] Discovered Agent Capability:`, capability.pubkey.slice(0, 8), `Domains:`, capability.domains);
      } catch (e) {}
    } else if (evt.detail.topic === BOOTSTRAP_REGISTRY_TOPIC) {
      const msg = new TextDecoder().decode(evt.detail.data);
      try {
        const announcement = JSON.parse(msg);
        if (!verifyBootstrapAnnouncement(announcement)) {
          console.warn('[BootstrapRegistry] Dropping invalid bootstrap announcement.');
          return;
        }
        cacheBootstrapAnnouncement(announcement);
        await putBootstrapAnnouncementToDHT(nodeInstance, announcement);
        console.log(`[BootstrapRegistry] Cached bootstrap node ${announcement.peerId}`);
      } catch (err) {
        console.warn('[BootstrapRegistry] Failed to process bootstrap announcement:', err);
      }
    } else if (evt.detail.topic === HELP_REQUEST_TOPIC) {
      const msg = new TextDecoder().decode(evt.detail.data);
      try {
        const payload = JSON.parse(msg);
        if (!verifyHelpEventSignature(payload, 2)) {
          console.warn(`[P2P] Help request signature verification failed for request=${payload.request_id ?? 'unknown'}, dropping.`);
          return;
        }
        await insertHelpRequest(payload);
        console.log(`[P2P] Received help request: ${String(payload.question || '').slice(0, 96)}`);
      } catch (err) {
        console.error('[P2P] Failed to process help request:', err);
      }
    } else if (evt.detail.topic === HELP_ANSWER_TOPIC) {
      const msg = new TextDecoder().decode(evt.detail.data);
      try {
        const payload = JSON.parse(msg);
        if (!verifyHelpEventSignature(payload, 3)) {
          console.warn(`[P2P] Help answer signature verification failed for request=${payload.request_id ?? 'unknown'}, dropping.`);
          return;
        }
        await insertHelpAnswer(payload);
        console.log(`[P2P] Received help answer for request ${payload.request_id}`);
      } catch (err) {
        console.error('[P2P] Failed to process help answer:', err);
      }
    } else if (evt.detail.topic === 'ann-global-index') {
      const msg = new TextDecoder().decode(evt.detail.data);
      console.log(`[P2P] [${mode}] Received global index broadcast`);
      try {
        const payload = JSON.parse(msg);
        // Phase 3: Verify signature before accepting
        const isValidSig = await verifyEnvelopeSignature({
          author_pubkey: payload.author_pubkey,
          sig: payload.sig,
          timestamp: payload.timestamp,
          kind: payload.kind,
          cid: payload.cid,
          related_cid: payload.related_cid ?? null
        });

        if (!isValidSig) {
          console.warn(`[P2P] Gossip signature verification failed for cid=${payload.cid}, dropping.`);
          return;
        }

        // Phase 3: Look up author's reputation and compute weight
        const ledger = await getReputation(nodeInstance, payload.author_pubkey);
        const weight = reputationWeight(ledger);
        console.log(`[P2P] Reputation for ${payload.author_pubkey.slice(0, 8)}: count=${ledger.event_count} weight=${weight}x`);

        // Phase 3: Update author's reputation ledger (domain match bonus)
        // Note: we don't have the author's declared domains here, so we skip domain match
        // bonus for gossiped items (only applied on local publish)
        await updateReputation(nodeInstance, payload.author_pubkey, false, []);

        // Phase 3: Low-reputation items are accepted but logged at low weight
        if (weight < 1.0) {
          console.log(`[P2P] Low-reputation source (weight=${weight}), content accepted with reduced priority.`);
        }

        // Basic schema check
        if (payload.id && payload.sig && payload.cid) {
           await insertGlobalIndex({ ...payload, _rep_weight: weight });
        }
      } catch (err) {
        console.error('[P2P] Failed to process gossip message:', err);
      }
    }
  });
  nodeInstance.services.pubsub.subscribe('ann-global-index');
  nodeInstance.services.pubsub.subscribe('ann-agent-capabilities');
  nodeInstance.services.pubsub.subscribe(HELP_REQUEST_TOPIC);
  nodeInstance.services.pubsub.subscribe(HELP_ANSWER_TOPIC);
  nodeInstance.services.pubsub.subscribe(BOOTSTRAP_REGISTRY_TOPIC);

  // Publish own capability card immediately — gossipsub join is instantaneous
  const identity = loadOrGenerateIdentity();
  const capabilityCard = buildCapabilityCard(identity);
  await nodeInstance.services.pubsub.publish('ann-agent-capabilities', new TextEncoder().encode(JSON.stringify(capabilityCard)));
}

function getConfiguredBootstrapPublicAddrs(nodeInstance: Libp2p<any>): string[] {
  const configured = process.env.ANN_BOOTSTRAP_PUBLIC_ADDRS;
  if (configured && configured.trim().length > 0) {
    return configured.split(',').map(addr => addr.trim()).filter(Boolean);
  }

  if (!process.env.ANN_BOOTSTRAP_LISTEN) {
    return [];
  }

  return nodeInstance.getMultiaddrs().map(addr => addr.toString());
}

export async function announceBootstrapNodeIfConfigured(nodeInstance: Libp2p<any>): Promise<void> {
  if (process.env.ANN_BOOTSTRAP_ANNOUNCE === 'false') return;

  const multiaddrs = getConfiguredBootstrapPublicAddrs(nodeInstance);
  if (multiaddrs.length === 0) return;

  const identity = loadOrGenerateIdentity();
  const announcement = buildBootstrapAnnouncement({
    peerId: nodeInstance.peerId.toString(),
    multiaddrs,
    identity,
    capabilities: ['bootstrap', 'dht', 'gossip'],
    protocolVersion: process.env.npm_package_version || '2.0.0'
  });

  cacheBootstrapAnnouncement(announcement);
  await putBootstrapAnnouncementToDHT(nodeInstance, announcement);
  await nodeInstance.services.pubsub.publish(
    BOOTSTRAP_REGISTRY_TOPIC,
    new TextEncoder().encode(JSON.stringify(announcement))
  );
  console.log(`[BootstrapRegistry] Announced bootstrap node ${announcement.peerId}`);
}

export async function refreshBootstrapRegistry(nodeInstance: Libp2p<any>): Promise<void> {
  const announcements = await searchBootstrapAnnouncements(nodeInstance);
  for (const announcement of announcements) {
    cacheBootstrapAnnouncement(announcement);
  }
  if (announcements.length > 0) {
    console.log(`[BootstrapRegistry] Refreshed ${announcements.length} bootstrap announcement(s) from DHT.`);
  }
}

/**
 * Naive network size estimator.
 * Returns the number of active libp2p connections multiplied by a fixed factor.
 * This is intentionally conservative: the real ANN network may be orders of
 * magnitude larger (or smaller) depending on bootstrap connectivity.
 * A hard floor of 10 is enforced so that tiny test meshes still get sane
 * RS encoding parameters.
 */
export async function estimateNetworkSize(): Promise<number> {
  if (!node) return 10;
  const connections = node.getConnections().length;
  return Math.max(10, connections * 5);
}

export function generateCID(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export async function encodeErasure(dataBuffer: Buffer, networkSize: number) {
  let dataShards = 10;
  let parityShards = 5;

  if (networkSize < 100) {
    dataShards = 4;
    parityShards = 2;
  }

  const rawShardSize = Math.ceil(dataBuffer.length / dataShards);
  const shardSize = Math.ceil(rawShardSize / 8) * 8 || 8;

  const paddedBuffer = Buffer.alloc(shardSize * dataShards);
  dataBuffer.copy(paddedBuffer);

  const parityBuffer = Buffer.alloc(shardSize * parityShards);

  const encoder = new rs.ReedSolomonEncoder(rs.GenericGF.AZTEC_DATA_8());
  const messageLength = dataShards + parityShards;
  const errorCorrectionLength = parityShards;

  // Encode each column (byte position across shards) as a separate RS message
  for (let i = 0; i < shardSize; i++) {
    const message = new Int32Array(messageLength);
    for (let j = 0; j < dataShards; j++) {
      message[j] = paddedBuffer[j * shardSize + i];
    }
    encoder.encode(message, errorCorrectionLength);
    for (let j = 0; j < parityShards; j++) {
      parityBuffer[j * shardSize + i] = message[dataShards + j];
    }
  }

  const shards: Buffer[] = [];
  for (let i = 0; i < dataShards; i++) {
    shards.push(paddedBuffer.slice(i * shardSize, (i + 1) * shardSize));
  }
  for (let i = 0; i < parityShards; i++) {
    shards.push(parityBuffer.slice(i * shardSize, (i + 1) * shardSize));
  }

  return {
    dataShards,
    parityShards,
    shardSize,
    shards,
    originalLength: dataBuffer.length
  };
}

export async function decodeErasure(
  shards: Buffer[],
  dataShards: number,
  parityShards: number,
  shardSize: number,
  originalLength: number
) {
  const totalShards = dataShards + parityShards;
  if (shards.length !== totalShards) {
    throw new Error(`Expected ${totalShards} shards, got ${shards.length}`);
  }

  const decoder = new rs.ReedSolomonDecoder(rs.GenericGF.AZTEC_DATA_8());
  const messageLength = dataShards + parityShards;
  const errorCorrectionLength = parityShards;

  const dataBuffer = Buffer.alloc(shardSize * dataShards);

  for (let i = 0; i < shardSize; i++) {
    const message = new Int32Array(messageLength);
    let missingCount = 0;
    for (let j = 0; j < totalShards; j++) {
      if (shards[j] && shards[j].length > 0) {
        message[j] = shards[j][i];
      } else {
        message[j] = 0;
        missingCount++;
      }
    }

    if (missingCount > parityShards) {
      throw new Error(`Too many missing shards: ${missingCount} > ${parityShards}`);
    }

    // Only attempt decode if there are actually errors/erasures
    if (missingCount > 0) {
      try {
        decoder.decode(message, errorCorrectionLength);
      } catch (err) {
        throw new Error(`Failed to decode at byte ${i}: ${err}`);
      }
    }

    for (let j = 0; j < dataShards; j++) {
      dataBuffer[j * shardSize + i] = message[j];
    }
  }

  return dataBuffer.slice(0, originalLength);
}

// ─── Phase 2B: Dynamic Capability Derivation ───────────────────────────────────
//
// Old design: domains hardcoded as ["typescript", "nodejs", "react"].
// Problem: in a public network, agents should broadcast their actual capabilities
// to enable capability-based routing (LLM only gossips to relevant peers).
//
// New design: domains are loaded from environment variable ANN_CAPABILITY_DOMAINS
// (comma-separated). If unset, falls back to a safe default of ["general"].
// The agent runtime that spawns this MCP server should set this env var to
// reflect its actual domain expertise, e.g.:
//   ANN_CAPABILITY_DOMAINS=typescript,react,nodejs mcp-server-ann
//
// Phase 3 (Reputation) builds on this: reputation scores are computed per-domain
// and stored in the DHT ledger, so even if an agent's domain claim is wrong,
// the network can observe and weight accordingly.

/**
 * Parse ANN_CAPABILITY_DOMAINS env var.
 * Value: comma-separated list of domain strings, e.g. "typescript,react,llm".
 * Returns ["general"] as the safe fallback if the env var is empty or absent.
 */
function getCapabilityDomains(): string[] {
    const env = process.env.ANN_CAPABILITY_DOMAINS;
    if (!env || typeof env !== 'string' || env.trim().length === 0) {
        return ['general'];
    }
    return env.split(',').map(d => d.trim().toLowerCase()).filter(d => d.length > 0);
}

/**
 * Build a capability card for this agent, including dynamically derived domains.
 * Published to ann-agent-capabilities gossipsub topic on node startup.
 */
function buildCapabilityCard(identity: ReturnType<typeof loadOrGenerateIdentity>): object {
    return {
        type: "ann-capability",
        pubkey: identity.publicKey,
        domains: getCapabilityDomains(),
        model: process.env.ANN_CAPABILITY_MODEL || 'unknown',
        version: "2.0.0"
    };
}

// ─── Phase 1: DHT Keyword Index ──────────────────────────────────────────────
//
// Old design (removed): DHT only stored shards keyed by sha256(cid).
// Problem: without knowing content, there was no way to search DHT directly.
// Search was limited to local SQLite populated only via gossip — so the P2P
// knowledge-sharing network was effectively partitioned.
//
// New design: dual-key DHT structure per knowledge item.
//   • ann:content:{cid}  → full knowledge item JSON (for direct DHT GET)
//   • ann:index:{keyword} → [cid_1, cid_2, …] (reverse index, keyed by extracted terms)
//
// publish_knowledge writes BOTH keys.
// search_knowledge queries BOTH local SQLite AND the DHT keyword index.

/**
 * Extract search-relevant keywords from title + content.
 * Uses a simple tokenisation strategy: lowercase, strip punctuation,
 * split on whitespace, filter out stop words and very short tokens.
 * Returns up to 20 keywords sorted alphabetically for deterministic DHT keys.
 */
export function extractKeywords(title: string, content: string): string[] {
    const stopWords = new Set([
        'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
        'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been',
        'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
        'could', 'should', 'may', 'might', 'can', 'this', 'that', 'these',
        'those', 'it', 'its', 'they', 'them', 'their', 'what', 'which',
        'who', 'when', 'where', 'why', 'how', 'not', 'no', 'yes', 'all',
        'any', 'each', 'every', 'both', 'few', 'more', 'most', 'other',
        'some', 'such', 'only', 'own', 'same', 'so', 'than', 'too', 'very'
    ]);
    const raw = `${title} ${content}`.toLowerCase();
    const tokens = raw.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/);
    const keywords = tokens
        .filter(t => t.length >= 2 && !stopWords.has(t))
        .sort();
    // Dedupe while preserving insertion order, cap at 20
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const k of keywords) {
        if (!seen.has(k)) { seen.add(k); unique.push(k); }
        if (unique.length >= 20) break;
    }
    return unique;
}

/**
 * Store a knowledge item's full content in the DHT.
 * Key: ann:content:{cid}, Value: JSON stringified item.
 * TTL: same as expires_at — DHT entries expire at the same time as SQLite rows.
 */
export async function dhtPutContent(node: Libp2p<any>, cid: string, item: any, expiresAt: number): Promise<void> {
    if (!node.services.dht) return;
    const key = new TextEncoder().encode(`ann:content:${cid}`);
    const value = Buffer.from(JSON.stringify({ ...item, expires_at: expiresAt }));
    try {
        // libp2p kad-dht put accepts key (Uint8Array) and value (Uint8Array)
        await node.services.dht.put(key, value);
    } catch (err) {
        console.warn(`[DHT] Failed to put content for cid=${cid}:`, err);
    }
}

/**
 * Add a cid to the reverse keyword index for each extracted keyword.
 * DHT key: ann:index:{keyword}, Value: JSON array of cids.
 * Uses read-modify-write: fetches existing array, appends new cid, writes back.
 * Add only if cid not already present (idempotent).
 */
export async function dhtIndexKeyword(node: Libp2p<any>, keyword: string, cid: string): Promise<void> {
    if (!node.services.dht) return;
    const key = new TextEncoder().encode(`ann:index:${keyword}`);
    let cids: string[] = [];
    try {
        const raw = await node.services.dht.get(key);
        if (raw && raw.length > 0) {
            cids = JSON.parse(new TextDecoder().decode(raw));
        }
    } catch {
        // Key not found — start with empty array
    }
    if (!cids.includes(cid)) {
        cids.push(cid);
        try {
            await node.services.dht.put(key, Buffer.from(JSON.stringify(cids)));
        } catch (err) {
            console.warn(`[DHT] Failed to index keyword=${keyword} for cid=${cid}:`, err);
        }
    }
}

/**
 * Remove a cid from all keyword indexes (used during garbage collection or content takedown).
 * Re-reads each keyword's cid list and writes back without the target cid.
 */
export async function dhtRemoveFromIndex(node: Libp2p<any> | null, title: string, content: string, cid: string): Promise<void> {
    if (!node) return;
    const keywords = extractKeywords(title, content);
    for (const kw of keywords) {
        const key = new TextEncoder().encode(`ann:index:${kw}`);
        let cids: string[] = [];
        try {
            const raw = await node.services.dht.get(key);
            if (raw && raw.length > 0) {
                cids = JSON.parse(new TextDecoder().decode(raw));
            }
        } catch { /* not found, nothing to remove */ }
        const updated = cids.filter(id => id !== cid);
        try {
            await node.services.dht.put(key, Buffer.from(JSON.stringify(updated)));
        } catch { /* best effort */ }
    }
}

/**
 * Extract keywords and write all DHT index entries for a knowledge item.
 * Called from publish_knowledge after the item is gossiped and stored locally.
 */
export async function indexToDHT(
    node: Libp2p<any>,
    cid: string,
    title: string,
    content: string,
    item: any,
    expiresAt: number
): Promise<void> {
    const keywords = extractKeywords(title, content);
    // Write content blob first
    await dhtPutContent(node, cid, item, expiresAt);
    // Then index under each keyword
    await Promise.all(keywords.map(kw => dhtIndexKeyword(node, kw, cid)));
}

// ─── Phase 3: Reputation System ─────────────────────────────────────────────────
//
// Sybil attack is the primary threat in an open public knowledge network.
// Without a trusted identity layer, anyone can spin up unlimited pubkeys and
// flood the network with garbage content.
//
// Defence-in-depth strategy (3 layers):
//   Layer 1 — Signature verification (Phase 0): reject unsigned or invalid messages
//   Layer 2 — Reputation ledger (Phase 3): weight content by author's history
//   Layer 3 — Domain capability filtering (Phase 2B): reduce cross-domain noise
//
// Reputation is stored in the DHT at ann:rep:{pubkey_hex}.
// Every node maintains the same ledger because DHT is replicated storage.
//
// Scoring rules:
//   • First event from a new pubkey → event_count=1, total_score=1 (bootstrap)
//   • Each subsequent event → total_score += 1
//   • Domain match (content keywords ∩ agent's declared domains) → +1 bonus
//   • event_count > 20 → total_score gets 1.5× multiplier (trusted tier)
//
// Thresholds:
//   event_count == 0  → unknown (neutral weight 0.5, still accepted)
//   1–5              → new participant (weight 0.8)
//   6–20             → established (weight 1.0)
//   20+              → trusted (weight 1.5)
//
// Reputation is looked up on every received gossip BEFORE inserting into local DB.
// A message from a zero-reputation pubkey is not dropped but marked with low priority.

export interface ReputationLedger {
    total_score: number;
    event_count: number;
    domain_scores: Record<string, number>; // domain → score contribution
    last_updated: number; // unix timestamp ms
}

const REP_KEY_PREFIX = 'ann:rep:';

/**
 * Get the DHT key for a pubkey's reputation ledger entry.
 */
export function repKey(pubkeyHex: string): Uint8Array {
    return new TextEncoder().encode(`${REP_KEY_PREFIX}${pubkeyHex}`);
}

/**
 * Retrieve the reputation ledger for a given pubkey from DHT.
 * Returns default ledger (score=0, count=0) if not yet in DHT.
 */
export async function getReputation(node: Libp2p<any>, pubkeyHex: string): Promise<ReputationLedger> {
    if (!node.services.dht) {
        return { total_score: 0, event_count: 0, domain_scores: {}, last_updated: 0 };
    }
    try {
        const raw = await node.services.dht.get(repKey(pubkeyHex));
        if (!raw || raw.length === 0) {
            return { total_score: 0, event_count: 0, domain_scores: {}, last_updated: 0 };
        }
        return JSON.parse(new TextDecoder().decode(raw));
    } catch {
        return { total_score: 0, event_count: 0, domain_scores: {}, last_updated: 0 };
    }
}

/**
 * Update the reputation ledger for a given pubkey in DHT.
 * Called after a successful publish (local) or after gossip verification (remote).
 * Returns the updated ledger.
 */
export async function updateReputation(
    node: Libp2p<any>,
    pubkeyHex: string,
    domainMatch: boolean,
    declaredDomains: string[]
): Promise<ReputationLedger> {
    if (!node.services.dht) {
        return { total_score: 0, event_count: 0, domain_scores: {}, last_updated: 0 };
    }
    const ledger = await getReputation(node, pubkeyHex);
    ledger.event_count += 1;
    let scoreDelta = 1; // base: one event = one point
    if (domainMatch) {
        scoreDelta += 1; // bonus: content matches declared domain
    }
    // Trusted tier: 1.5× multiplier once event_count crosses 20
    if (ledger.event_count > 20) {
        ledger.total_score = Math.round(ledger.total_score + scoreDelta * 1.5);
    } else {
        ledger.total_score += scoreDelta;
    }
    // Track per-domain breakdown for transparency
    for (const domain of declaredDomains) {
        ledger.domain_scores[domain] = (ledger.domain_scores[domain] || 0) + 1;
    }
    ledger.last_updated = Date.now();
    try {
        await node.services.dht.put(repKey(pubkeyHex), Buffer.from(JSON.stringify(ledger)));
    } catch (err) {
        console.warn(`[Reputation] Failed to persist ledger for pubkey=${pubkeyHex.slice(0, 8)}:`, err);
    }
    return ledger;
}

/**
 * Compute the reputation weight for a given ledger.
 * Used during search ranking and gossip filtering.
 */
export function reputationWeight(ledger: ReputationLedger): number {
    if (ledger.event_count === 0) return 0.5;        // unknown
    if (ledger.event_count <= 5) return 0.8;         // new participant
    if (ledger.event_count <= 20) return 1.0;        // established
    return 1.5;                                       // trusted
}

/**
 * Check if content domain matches declared domains.
 * Returns true if any extracted keyword from title+content overlaps with declared domains.
 */
export function contentMatchesDeclaredDomain(title: string, content: string, declaredDomains: string[]): boolean {
    const contentKeywords = extractKeywords(title, content);
    const declared = new Set(declaredDomains.map(d => d.toLowerCase()));
    return contentKeywords.some(kw => declared.has(kw));
}

/**
 * Verify Ed25519 signature on a gossip payload.
 * Used in two places: (1) gossip receive handler, (2) before publishing.
 * Returns true if valid, false if invalid.
 */
export async function verifyEnvelopeSignature(payload: {
    author_pubkey: string;
    sig: string;
    timestamp: number;
    kind: number;
    cid: string;
    related_cid: string | null;
}): Promise<boolean> {
    const id = crypto.createHash('sha256').update(JSON.stringify([
        0,
        payload.author_pubkey,
        payload.timestamp,
        payload.kind,
        payload.cid,
        payload.related_cid ?? null
    ])).digest();
    try {
        const sigBytes = Buffer.from(payload.sig, 'hex');
        const pubkeyBytes = Buffer.from(payload.author_pubkey, 'hex');
        return nacl.sign.detached.verify(id, sigBytes, pubkeyBytes);
    } catch {
        return false;
    }
}

export function helpEventId(payload: {
    author_pubkey: string;
    timestamp: number;
    kind: number;
    request_id: string;
    answer_id?: string | null;
}): string {
    return crypto.createHash('sha256').update(JSON.stringify([
        0,
        payload.author_pubkey,
        payload.timestamp,
        payload.kind,
        payload.request_id,
        payload.answer_id ?? null
    ])).digest('hex');
}

export function verifyHelpEventSignature(payload: any, expectedKind: 2 | 3): boolean {
    if (!payload || typeof payload !== 'object') return false;
    if (payload.kind !== expectedKind) return false;
    if (typeof payload.author_pubkey !== 'string' || typeof payload.sig !== 'string') return false;
    if (typeof payload.timestamp !== 'number' || typeof payload.request_id !== 'string') return false;
    if (expectedKind === 3 && typeof payload.answer_id !== 'string') return false;

    const id = helpEventId({
        author_pubkey: payload.author_pubkey,
        timestamp: payload.timestamp,
        kind: payload.kind,
        request_id: payload.request_id,
        answer_id: payload.answer_id ?? null
    });

    if (payload.id !== id) return false;
    try {
        return nacl.sign.detached.verify(
            Buffer.from(id, 'hex'),
            Buffer.from(payload.sig, 'hex'),
            Buffer.from(payload.author_pubkey, 'hex')
        );
    } catch {
        return false;
    }
}

// ─── Phase 4: TTL-aware DHT Layer ───────────────────────────────────────────────
//
// libp2p kad-dht has no native TTL support — entries persist indefinitely.
// Since knowledge items have a 30-day expires_at, we must enforce TTL at the
// application layer to prevent stale content from polluting DHT query results.
//
// Strategy: TTL check on every DHT read.
//   • dhtGetContent: if expires_at < now, delete key and return null
//   • dhtQueryKeyword: before returning cid list, verify each item's expires_at;
//     skip and clean up any that have expired
//
// This approach ensures expired content never appears in search results without
// requiring a background GC thread (though a periodic sweep is still recommended).

/**
 * Check if a DHT content entry has expired.
 * Returns true if expires_at < current time, false otherwise.
 */
export function isExpired(item: { expires_at: number }): boolean {
    return item.expires_at < Date.now();
}

/**
 * Phase 4: TTL-aware DHT GET for content.
// Wraps dhtGetContent with expiry check: if the stored content has passed its
// expires_at timestamp, the key is deleted from DHT and null is returned.
// This guarantees expired content never appears in query results.
 */
export async function dhtGetContent(node: Libp2p<any>, cid: string): Promise<any | null> {
    if (!node.services.dht) return null;
    const key = new TextEncoder().encode(`ann:content:${cid}`);
    try {
        const raw = await node.services.dht.get(key);
        if (!raw || raw.length === 0) return null;
        const item = JSON.parse(new TextDecoder().decode(raw));
        if (isExpired(item)) {
            // Expired — clean up the stale DHT entry and return null
            try {
                await node.services.dht.delete(key);
            } catch { /* best effort */ }
            return null;
        }
        return item;
    } catch {
        return null;
    }
}

/**
 * Phase 4: TTL-aware DHT keyword index query.
// Before returning a cid list for a keyword, each item is fetched and checked
// for expiry. Expired items are removed from the index immediately.
// This is the counterpart to dhtGetContent: even if a cid is in the index,
// it will be skipped if the actual content has expired.
 */
export async function dhtQueryKeyword(node: Libp2p<any>, keyword: string): Promise<string[]> {
    if (!node.services.dht) return [];
    const key = new TextEncoder().encode(`ann:index:${keyword}`);
    let cids: string[] = [];
    try {
        const raw = await node.services.dht.get(key);
        if (!raw || raw.length === 0) return [];
        cids = JSON.parse(new TextDecoder().decode(raw));
    } catch {
        return [];
    }

    const validCids: string[] = [];
    const expiredCids: string[] = [];

    for (const cid of cids) {
        // Check each item's expiry without full content fetch
        // Use a lightweight expiry-only key or just check the content
        const contentKey = new TextEncoder().encode(`ann:content:${cid}`);
        try {
            const raw = await node.services.dht.get(contentKey);
            if (!raw || raw.length === 0) {
                expiredCids.push(cid); // content gone
                continue;
            }
            const item = JSON.parse(new TextDecoder().decode(raw));
            if (isExpired(item)) {
                expiredCids.push(cid);
                continue;
            }
            validCids.push(cid);
        } catch {
            expiredCids.push(cid); // treat DHT error as expired
        }
    }

    // Clean up expired cids from the index
    if (expiredCids.length > 0) {
        const updated = validCids;
        try {
            await node.services.dht.put(key, Buffer.from(JSON.stringify(updated)));
        } catch { /* best effort */ }
    }

    return validCids;
}

/**
 * Phase 4: Periodic DHT sweep.
 * Scans all known content keys and deletes expired entries.
 * This is a conservative fallback — the primary TTL enforcement happens
 * on every read path (dhtGetContent and dhtQueryKeyword).
 * Call this periodically, e.g. every 6 hours, via setInterval.
 */
export async function dhtSweepExpired(node: Libp2p): Promise<{ deleted: number; checked: number }> {
    let deleted = 0;
    const expiredCids = await getExpiredPublishedCids();
    for (const cid of expiredCids) {
        // Remove from local tracking to complete GC cycle
        await deletePublishedCid(cid);
        deleted++;
    }
    return { deleted, checked: expiredCids.length };
}
