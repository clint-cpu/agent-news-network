import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import nacl from 'tweetnacl';
import type { Libp2p } from 'libp2p';
import type { Identity } from './identity.js';

export const BOOTSTRAP_REGISTRY_TOPIC = 'ann-bootstrap-registry';
export const BOOTSTRAP_INDEX_KEY = 'ann:bootstrap:index';
export const BOOTSTRAP_ANNOUNCEMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const BOOTSTRAP_CACHE_FILE = 'bootstrap-cache.json';

export interface BootstrapNodeAnnouncement {
  type: 'ann-bootstrap-node';
  version: 1;
  peerId: string;
  multiaddrs: string[];
  annPubkey: string;
  capabilities: string[];
  protocolVersion: string;
  issuedAt: number;
  expiresAt: number;
  signature: string;
}

type UnsignedBootstrapNodeAnnouncement = Omit<BootstrapNodeAnnouncement, 'signature'>;

function getIdentityDir(): string {
  return process.env.ANN_IDENTITY_DIR || path.join(os.homedir(), '.ann');
}

export function getBootstrapCachePath(): string {
  return path.join(getIdentityDir(), BOOTSTRAP_CACHE_FILE);
}

export function bootstrapAnnouncementKey(peerId: string): Uint8Array {
  return new TextEncoder().encode(`ann:bootstrap:${peerId}`);
}

export function bootstrapIndexKey(): Uint8Array {
  return new TextEncoder().encode(BOOTSTRAP_INDEX_KEY);
}

function canonicalBootstrapPayload(announcement: UnsignedBootstrapNodeAnnouncement): string {
  return JSON.stringify({
    type: announcement.type,
    version: announcement.version,
    peerId: announcement.peerId,
    multiaddrs: [...announcement.multiaddrs].sort(),
    annPubkey: announcement.annPubkey,
    capabilities: [...announcement.capabilities].sort(),
    protocolVersion: announcement.protocolVersion,
    issuedAt: announcement.issuedAt,
    expiresAt: announcement.expiresAt
  });
}

function announcementDigest(announcement: UnsignedBootstrapNodeAnnouncement): Buffer {
  return crypto.createHash('sha256').update(canonicalBootstrapPayload(announcement)).digest();
}

export function signBootstrapAnnouncement(
  announcement: UnsignedBootstrapNodeAnnouncement,
  privateKeyHex: string
): string {
  return Buffer.from(
    nacl.sign.detached(announcementDigest(announcement), Buffer.from(privateKeyHex, 'hex'))
  ).toString('hex');
}

export function buildBootstrapAnnouncement(params: {
  peerId: string;
  multiaddrs: string[];
  identity: Identity;
  capabilities?: string[];
  protocolVersion?: string;
  issuedAt?: number;
  ttlMs?: number;
}): BootstrapNodeAnnouncement {
  const issuedAt = params.issuedAt ?? Date.now();
  const unsigned: UnsignedBootstrapNodeAnnouncement = {
    type: 'ann-bootstrap-node',
    version: 1,
    peerId: params.peerId,
    multiaddrs: normalizeMultiaddrs(params.multiaddrs),
    annPubkey: params.identity.publicKey,
    capabilities: params.capabilities ?? ['bootstrap'],
    protocolVersion: params.protocolVersion ?? '2.1.0',
    issuedAt,
    expiresAt: issuedAt + (params.ttlMs ?? BOOTSTRAP_ANNOUNCEMENT_TTL_MS)
  };

  return {
    ...unsigned,
    signature: signBootstrapAnnouncement(unsigned, params.identity.privateKey)
  };
}

function normalizeMultiaddrs(multiaddrs: string[]): string[] {
  return Array.from(new Set(
    multiaddrs
      .map(addr => addr.trim())
      .filter(addr => addr.length > 0 && addr.includes('/p2p/'))
  )).sort();
}

export function isBootstrapAnnouncementExpired(
  announcement: Pick<BootstrapNodeAnnouncement, 'expiresAt'>,
  now = Date.now()
): boolean {
  return announcement.expiresAt <= now;
}

export function verifyBootstrapAnnouncement(announcement: unknown, now = Date.now()): announcement is BootstrapNodeAnnouncement {
  if (!announcement || typeof announcement !== 'object') return false;
  const candidate = announcement as BootstrapNodeAnnouncement;
  if (candidate.type !== 'ann-bootstrap-node') return false;
  if (candidate.version !== 1) return false;
  if (typeof candidate.peerId !== 'string' || candidate.peerId.length === 0) return false;
  if (!Array.isArray(candidate.multiaddrs) || normalizeMultiaddrs(candidate.multiaddrs).length === 0) return false;
  if (typeof candidate.annPubkey !== 'string' || !/^[0-9a-f]+$/i.test(candidate.annPubkey)) return false;
  if (!Array.isArray(candidate.capabilities)) return false;
  if (typeof candidate.protocolVersion !== 'string' || candidate.protocolVersion.length === 0) return false;
  if (!Number.isFinite(candidate.issuedAt) || !Number.isFinite(candidate.expiresAt)) return false;
  if (candidate.issuedAt > candidate.expiresAt) return false;
  if (isBootstrapAnnouncementExpired(candidate, now)) return false;
  if (typeof candidate.signature !== 'string' || !/^[0-9a-f]+$/i.test(candidate.signature)) return false;

  try {
    const unsigned: UnsignedBootstrapNodeAnnouncement = {
      type: candidate.type,
      version: candidate.version,
      peerId: candidate.peerId,
      multiaddrs: normalizeMultiaddrs(candidate.multiaddrs),
      annPubkey: candidate.annPubkey,
      capabilities: [...candidate.capabilities],
      protocolVersion: candidate.protocolVersion,
      issuedAt: candidate.issuedAt,
      expiresAt: candidate.expiresAt
    };
    return nacl.sign.detached.verify(
      announcementDigest(unsigned),
      Buffer.from(candidate.signature, 'hex'),
      Buffer.from(candidate.annPubkey, 'hex')
    );
  } catch {
    return false;
  }
}

export function mergeBootstrapAnnouncements(
  announcements: BootstrapNodeAnnouncement[],
  now = Date.now()
): BootstrapNodeAnnouncement[] {
  const latestByPeer = new Map<string, BootstrapNodeAnnouncement>();
  for (const announcement of announcements) {
    if (!verifyBootstrapAnnouncement(announcement, now)) continue;
    const existing = latestByPeer.get(announcement.peerId);
    if (!existing || announcement.expiresAt > existing.expiresAt) {
      latestByPeer.set(announcement.peerId, {
        ...announcement,
        multiaddrs: normalizeMultiaddrs(announcement.multiaddrs),
        capabilities: Array.from(new Set(announcement.capabilities)).sort()
      });
    }
  }
  return Array.from(latestByPeer.values()).sort((a, b) => a.peerId.localeCompare(b.peerId));
}

export function getCachedBootstrapMultiaddrs(now = Date.now()): string[] {
  return mergeBootstrapAnnouncements(loadBootstrapCache(), now).flatMap(item => item.multiaddrs);
}

export function loadBootstrapCache(cachePath = getBootstrapCachePath()): BootstrapNodeAnnouncement[] {
  try {
    if (!fs.existsSync(cachePath)) return [];
    const raw = fs.readFileSync(cachePath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveBootstrapCache(
  announcements: BootstrapNodeAnnouncement[],
  cachePath = getBootstrapCachePath()
): BootstrapNodeAnnouncement[] {
  const merged = mergeBootstrapAnnouncements(announcements);
  const dir = path.dirname(cachePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(cachePath, JSON.stringify(merged, null, 2), 'utf8');
  fs.chmodSync(cachePath, 0o600);
  return merged;
}

export function cacheBootstrapAnnouncement(announcement: BootstrapNodeAnnouncement): BootstrapNodeAnnouncement[] {
  const existing = loadBootstrapCache();
  return saveBootstrapCache([...existing, announcement]);
}

export async function putBootstrapAnnouncementToDHT(
  node: Libp2p<any>,
  announcement: BootstrapNodeAnnouncement
): Promise<void> {
  if (!node.services.dht || !verifyBootstrapAnnouncement(announcement)) return;
  try {
    await node.services.dht.put(
      bootstrapAnnouncementKey(announcement.peerId),
      Buffer.from(JSON.stringify(announcement))
    );

    let peerIds: string[] = [];
    try {
      const raw = await node.services.dht.get(bootstrapIndexKey());
      if (raw && raw.length > 0) {
        peerIds = JSON.parse(new TextDecoder().decode(raw));
      }
    } catch {
      peerIds = [];
    }

    if (!peerIds.includes(announcement.peerId)) {
      peerIds.push(announcement.peerId);
      await node.services.dht.put(bootstrapIndexKey(), Buffer.from(JSON.stringify(peerIds.sort())));
    }
  } catch (err) {
    console.warn(`[BootstrapRegistry] Failed to publish bootstrap announcement for ${announcement.peerId}:`, err);
  }
}

export async function searchBootstrapAnnouncements(node: Libp2p<any>): Promise<BootstrapNodeAnnouncement[]> {
  if (!node.services.dht) return [];
  try {
    const rawIndex = await node.services.dht.get(bootstrapIndexKey());
    if (!rawIndex || rawIndex.length === 0) return [];
    const peerIds = JSON.parse(new TextDecoder().decode(rawIndex));
    if (!Array.isArray(peerIds)) return [];

    const announcements = await Promise.all(peerIds.map(async peerId => {
      if (typeof peerId !== 'string') return null;
      try {
        const raw = await node.services.dht.get(bootstrapAnnouncementKey(peerId));
        if (!raw || raw.length === 0) return null;
        const parsed = JSON.parse(new TextDecoder().decode(raw));
        return verifyBootstrapAnnouncement(parsed) ? parsed : null;
      } catch {
        return null;
      }
    }));

    return mergeBootstrapAnnouncements(announcements.filter(Boolean) as BootstrapNodeAnnouncement[]);
  } catch {
    return [];
  }
}
