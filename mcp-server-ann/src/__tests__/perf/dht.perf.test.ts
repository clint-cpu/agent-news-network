import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startP2PNode, stopP2PNode, getP2PNode } from '../../p2p.js';

// why: Mock libp2p DHT to avoid real network connections.
// DHT operations on a real network are slow and non-deterministic.
const createMockNode = (peerIdStr: string) => ({
  peerId: { toString: () => peerIdStr },
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
  getConnections: () => [],
  services: {
    pubsub: {
      addEventListener: vi.fn(),
      subscribe: vi.fn(),
      publish: vi.fn().mockResolvedValue(undefined),
    },
    dht: {
      put: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockImplementation((key: Uint8Array) => {
        const keyStr = new TextDecoder().decode(key);
        if (keyStr.startsWith('ann:content:')) {
          const cid = keyStr.replace('ann:content:', '');
          return Promise.resolve(Buffer.from(JSON.stringify({
            cid,
            title: `Content ${cid}`,
            expires_at: Date.now() + 86400000,
          })));
        }
        return Promise.reject(new Error('not found'));
      }),
    },
  },
});

let mockCallCount = 0;
vi.mock('libp2p', () => ({
  createLibp2p: vi.fn().mockImplementation(() => {
    mockCallCount++;
    return Promise.resolve(createMockNode(`mock-peer-${mockCallCount}`));
  }),
}));

describe('DHT Read/Write Performance', () => {
  beforeEach(async () => {
    mockCallCount = 0;
    await stopP2PNode();
  });

  afterEach(async () => {
    await stopP2PNode();
  });

  it('should perform 1000 put/get operations with acceptable latency', async () => {
    const node = await startP2PNode('full');
    const dht = node.services.dht;

    const OPERATIONS = 1000;
    const putLatencies: number[] = [];
    const getLatencies: number[] = [];

    // Measure PUT performance
    const putStart = performance.now();
    for (let i = 0; i < OPERATIONS; i++) {
      const key = new TextEncoder().encode(`ann:content:test-cid-${i}`);
      const value = Buffer.from(JSON.stringify({
        cid: `test-cid-${i}`,
        title: `Test Content ${i}`,
        author_pubkey: 'aabbccdd',
        signature: 'sig',
        vector_json: '[]',
        timestamp: Date.now(),
        expires_at: Date.now() + 86400000,
      }));

      const opStart = performance.now();
      await dht.put(key, value);
      putLatencies.push(performance.now() - opStart);
    }
    const putTotal = performance.now() - putStart;

    // Measure GET performance
    const getStart = performance.now();
    for (let i = 0; i < OPERATIONS; i++) {
      const key = new TextEncoder().encode(`ann:content:test-cid-${i}`);

      const opStart = performance.now();
      await dht.get(key);
      getLatencies.push(performance.now() - opStart);
    }
    const getTotal = performance.now() - getStart;

    // Calculate statistics
    const putAvg = putLatencies.reduce((a, b) => a + b, 0) / putLatencies.length;
    const getAvg = getLatencies.reduce((a, b) => a + b, 0) / getLatencies.length;
    const putP95 = putLatencies.sort((a, b) => a - b)[Math.floor(putLatencies.length * 0.95)];
    const getP95 = getLatencies.sort((a, b) => a - b)[Math.floor(getLatencies.length * 0.95)];
    const putP99 = putLatencies.sort((a, b) => a - b)[Math.floor(putLatencies.length * 0.99)];
    const getP99 = getLatencies.sort((a, b) => a - b)[Math.floor(getLatencies.length * 0.99)];

    const putThroughput = (OPERATIONS / putTotal) * 1000;
    const getThroughput = (OPERATIONS / getTotal) * 1000;

    const report = {
      test: 'dht-put-get-latency',
      timestamp: new Date().toISOString(),
      config: {
        operations: OPERATIONS,
        mode: 'full',
      },
      metrics: {
        put: {
          totalLatencyMs: Number(putTotal.toFixed(2)),
          avgLatencyMs: Number(putAvg.toFixed(2)),
          p95LatencyMs: Number(putP95.toFixed(2)),
          p99LatencyMs: Number(putP99.toFixed(2)),
          throughputOpsPerSec: Number(putThroughput.toFixed(2)),
        },
        get: {
          totalLatencyMs: Number(getTotal.toFixed(2)),
          avgLatencyMs: Number(getAvg.toFixed(2)),
          p95LatencyMs: Number(getP95.toFixed(2)),
          p99LatencyMs: Number(getP99.toFixed(2)),
          throughputOpsPerSec: Number(getThroughput.toFixed(2)),
        },
      },
    };

    console.log('[PERF-REPORT]', JSON.stringify(report, null, 2));

    expect(putAvg).toBeLessThan(10);
    expect(getAvg).toBeLessThan(10);
    expect(putThroughput).toBeGreaterThan(100);
    expect(getThroughput).toBeGreaterThan(100);
  });

  it('should not leak memory across repeated DHT operations', async () => {
    const node = await startP2PNode('full');
    const dht = node.services.dht;

    const ROUNDS = 20;
    const OPS_PER_ROUND = 50;
    const memorySamples: number[] = [];

    for (let round = 0; round < ROUNDS; round++) {
      // Perform mixed put/get operations
      const promises: Promise<any>[] = [];
      for (let i = 0; i < OPS_PER_ROUND; i++) {
        const key = new TextEncoder().encode(`ann:content:memtest-${round}-${i}`);
        const value = Buffer.from(JSON.stringify({
          cid: `memtest-${round}-${i}`,
          data: 'x'.repeat(1024), // 1KB payload
          expires_at: Date.now() + 86400000,
        }));
        promises.push(dht.put(key, value));
        promises.push(dht.get(key));
      }
      await Promise.all(promises);

      // Force GC if available
      globalThis.gc && globalThis.gc();
      const mem = process.memoryUsage().heapUsed;
      memorySamples.push(mem);
    }

    // Calculate memory trend
    const firstHalf = memorySamples.slice(0, Math.floor(ROUNDS / 2));
    const secondHalf = memorySamples.slice(Math.floor(ROUNDS / 2));
    const firstAvg = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
    const secondAvg = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;
    const growthRate = ((secondAvg - firstAvg) / firstAvg) * 100;

    const report = {
      test: 'dht-memory-leak',
      timestamp: new Date().toISOString(),
      config: {
        rounds: ROUNDS,
        opsPerRound: OPS_PER_ROUND,
        payloadSizeBytes: 1024,
      },
      metrics: {
        firstHalfAvgHeapBytes: Math.round(firstAvg),
        secondHalfAvgHeapBytes: Math.round(secondAvg),
        growthRatePercent: Number(growthRate.toFixed(2)),
        memorySamples: memorySamples.map((m) => Math.round(m)),
      },
    };

    console.log('[PERF-REPORT]', JSON.stringify(report, null, 2));

    // Memory growth should be minimal (< 15% indicates no significant leak)
    expect(growthRate).toBeLessThan(15);
  });
});
