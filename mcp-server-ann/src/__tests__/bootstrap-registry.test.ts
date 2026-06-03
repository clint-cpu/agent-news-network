import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import nacl from 'tweetnacl';
import {
  BOOTSTRAP_INDEX_KEY,
  bootstrapAnnouncementKey,
  buildBootstrapAnnouncement,
  getCachedBootstrapMultiaddrs,
  loadBootstrapCache,
  mergeBootstrapAnnouncements,
  putBootstrapAnnouncementToDHT,
  saveBootstrapCache,
  searchBootstrapAnnouncements,
  verifyBootstrapAnnouncement
} from '../bootstrap-registry.js';

function createIdentity() {
  const kp = nacl.sign.keyPair();
  return {
    publicKey: Buffer.from(kp.publicKey).toString('hex'),
    privateKey: Buffer.from(kp.secretKey).toString('hex')
  };
}

function createMockNode() {
  const store = new Map<string, Uint8Array>();
  return {
    services: {
      dht: {
        put: vi.fn(async (key: Uint8Array, value: Uint8Array) => {
          store.set(Buffer.from(key).toString(), value);
        }),
        get: vi.fn(async (key: Uint8Array) => {
          return store.get(Buffer.from(key).toString()) ?? null;
        })
      }
    },
    _store: store
  };
}

describe('bootstrap registry', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ann-bootstrap-registry-'));
    process.env.ANN_IDENTITY_DIR = tempDir;
  });

  afterEach(() => {
    delete process.env.ANN_IDENTITY_DIR;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('builds and verifies a signed bootstrap announcement', () => {
    const announcement = buildBootstrapAnnouncement({
      peerId: '12D3KooWTestPeer',
      multiaddrs: ['/ip4/203.0.113.10/tcp/41230/ws/p2p/12D3KooWTestPeer'],
      identity: createIdentity(),
      issuedAt: Date.now()
    });

    expect(verifyBootstrapAnnouncement(announcement)).toBe(true);
  });

  it('rejects tampered announcements', () => {
    const announcement = buildBootstrapAnnouncement({
      peerId: '12D3KooWTestPeer',
      multiaddrs: ['/ip4/203.0.113.10/tcp/41230/ws/p2p/12D3KooWTestPeer'],
      identity: createIdentity()
    });

    const tampered = {
      ...announcement,
      multiaddrs: ['/ip4/198.51.100.20/tcp/41230/ws/p2p/12D3KooWTestPeer']
    };

    expect(verifyBootstrapAnnouncement(tampered)).toBe(false);
  });

  it('rejects expired announcements', () => {
    const now = Date.now();
    const announcement = buildBootstrapAnnouncement({
      peerId: '12D3KooWExpired',
      multiaddrs: ['/ip4/203.0.113.10/tcp/41230/ws/p2p/12D3KooWExpired'],
      identity: createIdentity(),
      issuedAt: now - 10_000,
      ttlMs: 1
    });

    expect(verifyBootstrapAnnouncement(announcement, now)).toBe(false);
  });

  it('dedupes cache entries by peer id and keeps the latest expiry', () => {
    const identity = createIdentity();
    const older = buildBootstrapAnnouncement({
      peerId: '12D3KooWDedupe',
      multiaddrs: ['/ip4/203.0.113.10/tcp/41230/ws/p2p/12D3KooWDedupe'],
      identity,
      issuedAt: Date.now()
    });
    const newer = buildBootstrapAnnouncement({
      peerId: '12D3KooWDedupe',
      multiaddrs: ['/ip4/203.0.113.11/tcp/41230/ws/p2p/12D3KooWDedupe'],
      identity,
      issuedAt: Date.now() + 1000
    });

    const merged = saveBootstrapCache([older, newer]);

    expect(merged).toHaveLength(1);
    expect(loadBootstrapCache()).toHaveLength(1);
    expect(getCachedBootstrapMultiaddrs()).toEqual([
      '/ip4/203.0.113.11/tcp/41230/ws/p2p/12D3KooWDedupe'
    ]);
  });

  it('stores and searches announcements through the DHT index', async () => {
    const node = createMockNode();
    const announcement = buildBootstrapAnnouncement({
      peerId: '12D3KooWDhtPeer',
      multiaddrs: ['/ip4/203.0.113.12/tcp/41230/ws/p2p/12D3KooWDhtPeer'],
      identity: createIdentity()
    });

    await putBootstrapAnnouncementToDHT(node as any, announcement);

    expect(node._store.has(Buffer.from(bootstrapAnnouncementKey(announcement.peerId)).toString())).toBe(true);
    expect(node._store.has(BOOTSTRAP_INDEX_KEY)).toBe(true);

    const found = await searchBootstrapAnnouncements(node as any);
    expect(found).toHaveLength(1);
    expect(found[0].peerId).toBe(announcement.peerId);
  });

  it('filters invalid announcements when merging', () => {
    const announcement = buildBootstrapAnnouncement({
      peerId: '12D3KooWValid',
      multiaddrs: ['/ip4/203.0.113.13/tcp/41230/ws/p2p/12D3KooWValid'],
      identity: createIdentity()
    });

    const merged = mergeBootstrapAnnouncements([
      announcement,
      { ...announcement, peerId: '12D3KooWInvalid' }
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0].peerId).toBe('12D3KooWValid');
  });
});
