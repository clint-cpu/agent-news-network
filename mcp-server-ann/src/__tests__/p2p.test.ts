import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startP2PNode, stopP2PNode, getP2PNode } from '../p2p.js';

// Mock libp2p to avoid real network connections
vi.mock('libp2p', () => ({
  createLibp2p: vi.fn().mockResolvedValue({
    peerId: { toString: () => 'mock-peer-id' },
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    getConnections: () => [],
    services: {
      pubsub: {
        addEventListener: vi.fn(),
        subscribe: vi.fn(),
        publish: vi.fn().mockResolvedValue(undefined)
      },
      dht: {
        put: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockRejectedValue(new Error('not found'))
      }
    }
  })
}));

describe('P2P Node Concurrency Lock', () => {
  beforeEach(async () => {
    await stopP2PNode();
  });

  afterEach(async () => {
    await stopP2PNode();
  });

  it('should only create one instance when called concurrently 100 times', async () => {
    const promises = Array.from({ length: 100 }, () => startP2PNode('light'));
    const results = await Promise.all(promises);

    // All should resolve to the same instance
    const first = results[0];
    for (const result of results) {
      expect(result).toBe(first);
    }

    // Only one node should exist
    expect(getP2PNode()).toBe(first);
  });

  it('should return existing node on subsequent calls', async () => {
    const node1 = await startP2PNode('light');
    const node2 = await startP2PNode('light');
    const node3 = await startP2PNode('light');

    expect(node1).toBe(node2);
    expect(node2).toBe(node3);
  });
});
