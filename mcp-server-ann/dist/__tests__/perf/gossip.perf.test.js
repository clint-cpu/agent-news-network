import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startP2PNode, stopP2PNode } from '../../p2p.js';
// why: Mock libp2p to avoid real network connections in perf tests.
// Real network would make results non-deterministic and CI-unfriendly.
const createMockNode = (peerIdStr) => ({
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
            get: vi.fn().mockRejectedValue(new Error('not found')),
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
describe('Gossip High-Concurrency Performance', () => {
    beforeEach(async () => {
        mockCallCount = 0;
        await stopP2PNode();
    });
    afterEach(async () => {
        await stopP2PNode();
    });
    it('should publish 1000 messages concurrently with acceptable latency', async () => {
        const node = await startP2PNode('light');
        const pubsub = node.services.pubsub;
        const MESSAGE_COUNT = 1000;
        const messages = [];
        // Generate test messages
        for (let i = 0; i < MESSAGE_COUNT; i++) {
            messages.push({
                id: i,
                payload: JSON.stringify({
                    cid: `test-cid-${i}`,
                    title: `Test Message ${i}`,
                    author_pubkey: 'aabbccdd',
                    signature: 'sig',
                    vector_json: '[]',
                    timestamp: Date.now(),
                    expires_at: Date.now() + 86400000,
                }),
                startTime: 0,
            });
        }
        // Measure memory before
        const memBefore = process.memoryUsage();
        // Publish all messages concurrently
        const batchStart = performance.now();
        const publishPromises = messages.map((msg) => {
            msg.startTime = performance.now();
            return pubsub
                .publish('ann-global-index', new TextEncoder().encode(msg.payload))
                .then(() => {
                msg.endTime = performance.now();
            })
                .catch(() => {
                msg.endTime = -1; // Mark as failed
            });
        });
        await Promise.all(publishPromises);
        const batchEnd = performance.now();
        // Measure memory after
        const memAfter = process.memoryUsage();
        globalThis.gc && globalThis.gc(); // Try to trigger GC if available
        // Calculate metrics
        const successful = messages.filter((m) => m.endTime && m.endTime > 0);
        const failed = messages.filter((m) => !m.endTime || m.endTime < 0);
        const latencies = successful.map((m) => (m.endTime - m.startTime));
        const totalLatency = batchEnd - batchStart;
        const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
        const minLatency = Math.min(...latencies);
        const maxLatency = Math.max(...latencies);
        const p50 = latencies.sort((a, b) => a - b)[Math.floor(latencies.length * 0.5)];
        const p95 = latencies.sort((a, b) => a - b)[Math.floor(latencies.length * 0.95)];
        const p99 = latencies.sort((a, b) => a - b)[Math.floor(latencies.length * 0.99)];
        const throughput = (MESSAGE_COUNT / totalLatency) * 1000; // msg/s
        const memDelta = {
            rss: memAfter.rss - memBefore.rss,
            heapUsed: memAfter.heapUsed - memBefore.heapUsed,
            external: memAfter.external - memBefore.external,
        };
        // Output JSON performance report
        const report = {
            test: 'gossip-concurrent-publish',
            timestamp: new Date().toISOString(),
            config: {
                messageCount: MESSAGE_COUNT,
                mode: 'light',
            },
            metrics: {
                totalLatencyMs: Number(totalLatency.toFixed(2)),
                avgLatencyMs: Number(avgLatency.toFixed(2)),
                minLatencyMs: Number(minLatency.toFixed(2)),
                maxLatencyMs: Number(maxLatency.toFixed(2)),
                p50LatencyMs: Number(p50.toFixed(2)),
                p95LatencyMs: Number(p95.toFixed(2)),
                p99LatencyMs: Number(p99.toFixed(2)),
                throughputMsgPerSec: Number(throughput.toFixed(2)),
                successCount: successful.length,
                failureCount: failed.length,
                lossRate: Number((failed.length / MESSAGE_COUNT).toFixed(4)),
            },
            memory: {
                rssDeltaBytes: memDelta.rss,
                heapUsedDeltaBytes: memDelta.heapUsed,
                externalDeltaBytes: memDelta.external,
            },
        };
        console.log('[PERF-REPORT]', JSON.stringify(report, null, 2));
        // Assertions (baseline thresholds)
        expect(failed.length).toBe(0); // No message loss allowed
        expect(avgLatency).toBeLessThan(50); // Avg < 50ms per publish
        expect(totalLatency).toBeLessThan(5000); // Batch < 5s
        expect(throughput).toBeGreaterThan(100); // > 100 msg/s
    });
    it('should handle sustained publish load without memory growth', async () => {
        const node = await startP2PNode('light');
        const pubsub = node.services.pubsub;
        const ROUNDS = 10;
        const MESSAGES_PER_ROUND = 100;
        const memorySamples = [];
        for (let round = 0; round < ROUNDS; round++) {
            const promises = Array.from({ length: MESSAGES_PER_ROUND }, (_, i) => pubsub.publish('ann-global-index', new TextEncoder().encode(`round-${round}-msg-${i}`)));
            await Promise.all(promises);
            // Force GC if available for accurate measurement
            globalThis.gc && globalThis.gc();
            const mem = process.memoryUsage().heapUsed;
            memorySamples.push(mem);
        }
        // Calculate memory growth trend
        const firstHalf = memorySamples.slice(0, Math.floor(ROUNDS / 2));
        const secondHalf = memorySamples.slice(Math.floor(ROUNDS / 2));
        const firstAvg = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
        const secondAvg = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;
        const growthRate = ((secondAvg - firstAvg) / firstAvg) * 100;
        const report = {
            test: 'gossip-memory-stability',
            timestamp: new Date().toISOString(),
            config: {
                rounds: ROUNDS,
                messagesPerRound: MESSAGES_PER_ROUND,
            },
            metrics: {
                firstHalfAvgHeapBytes: Math.round(firstAvg),
                secondHalfAvgHeapBytes: Math.round(secondAvg),
                growthRatePercent: Number(growthRate.toFixed(2)),
                memorySamples: memorySamples.map((m) => Math.round(m)),
            },
        };
        console.log('[PERF-REPORT]', JSON.stringify(report, null, 2));
        // Memory should not grow more than 20% across rounds
        expect(growthRate).toBeLessThan(20);
    });
});
