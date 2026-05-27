import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  dhtPutContent,
  dhtGetContent,
  dhtIndexKeyword,
  dhtQueryKeyword,
  isExpired,
  extractKeywords,
} from '../p2p.js';

// Build a minimal mock node with in-memory DHT
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
        }),
        delete: vi.fn(async (key: Uint8Array) => {
          store.delete(Buffer.from(key).toString());
        }),
      },
    },
    _store: store,
  };
}

describe('DHT Read/Write', () => {
  let mockNode: ReturnType<typeof createMockNode>;

  beforeEach(() => {
    mockNode = createMockNode();
  });

  it('should put and get content', async () => {
    const cid = 'abc123';
    const item = { title: 'Test', content: 'Hello' };
    const expiresAt = Date.now() + 10000;

    await dhtPutContent(mockNode as any, cid, item, expiresAt);
    const result = await dhtGetContent(mockNode as any, cid);

    expect(result).toBeDefined();
    expect(result.title).toBe('Test');
    expect(result.expires_at).toBe(expiresAt);
  });

  it('should return null for non-existent key', async () => {
    const result = await dhtGetContent(mockNode as any, 'nonexistent');
    expect(result).toBeNull();
  });

  it('should index and query keywords', async () => {
    const cid = 'cid-1';
    await dhtIndexKeyword(mockNode as any, 'typescript', cid);
    await dhtIndexKeyword(mockNode as any, 'nodejs', cid);

    // Also put valid content so dhtQueryKeyword doesn't expire them away
    const contentKeyTs = new TextEncoder().encode('ann:content:' + cid);
    await mockNode.services.dht.put(contentKeyTs, Buffer.from(JSON.stringify({ title: 'T', expires_at: Date.now() + 10000 })));

    const tsCids = await dhtQueryKeyword(mockNode as any, 'typescript');
    const nodeCids = await dhtQueryKeyword(mockNode as any, 'nodejs');

    expect(tsCids).toContain(cid);
    expect(nodeCids).toContain(cid);
  });

  it('should dedupe cids in keyword index', async () => {
    const cid = 'cid-1';
    await dhtIndexKeyword(mockNode as any, 'rust', cid);
    await dhtIndexKeyword(mockNode as any, 'rust', cid);

    // Put valid content so dhtQueryKeyword doesn't expire the cid
    const contentKeyRust = new TextEncoder().encode('ann:content:' + cid);
    await mockNode.services.dht.put(contentKeyRust, Buffer.from(JSON.stringify({ title: 'R', expires_at: Date.now() + 10000 })));

    const cids = await dhtQueryKeyword(mockNode as any, 'rust');
    expect(cids).toHaveLength(1);
  });

  it('should clean up expired entries on query', async () => {
    const cid = 'expired-cid';
    const item = { title: 'Old', expires_at: Date.now() - 1000 };

    // Manually put expired content
    const contentKey = new TextEncoder().encode(`ann:content:${cid}`);
    await mockNode.services.dht.put(contentKey, Buffer.from(JSON.stringify(item)));

    // Also index it
    await dhtIndexKeyword(mockNode as any, 'oldstuff', cid);

    const result = await dhtGetContent(mockNode as any, cid);
    expect(result).toBeNull();

    const cids = await dhtQueryKeyword(mockNode as any, 'oldstuff');
    expect(cids).not.toContain(cid);
  });

  it('should extract keywords correctly', () => {
    const keywords = extractKeywords('Hello World', 'This is a test about TypeScript and NodeJS');
    expect(keywords).toContain('typescript');
    expect(keywords).toContain('nodejs');
    expect(keywords).not.toContain('is');
    expect(keywords).not.toContain('a');
  });

  it('should detect expired items', () => {
    expect(isExpired({ expires_at: Date.now() - 1 })).toBe(true);
    expect(isExpired({ expires_at: Date.now() + 10000 })).toBe(false);
  });
});
