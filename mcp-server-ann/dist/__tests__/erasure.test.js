import { describe, it, expect } from 'vitest';
import { encodeErasure, decodeErasure } from '../p2p.js';
describe('Erasure Coding', () => {
    it('should encode and decode data correctly', async () => {
        const data = Buffer.from('Hello, ANN World! This is a test message for Reed-Solomon erasure coding.');
        const networkSize = 50;
        const encoded = await encodeErasure(data, networkSize);
        expect(encoded.shards.length).toBe(encoded.dataShards + encoded.parityShards);
        const decoded = await decodeErasure(encoded.shards, encoded.dataShards, encoded.parityShards, encoded.shardSize, encoded.originalLength);
        expect(decoded.toString()).toBe(data.toString());
    });
    it('should recover data when 1 data shard is lost', async () => {
        const data = Buffer.from('Important data that must survive shard losses!');
        const networkSize = 50;
        const encoded = await encodeErasure(data, networkSize);
        const { dataShards, parityShards, shardSize, originalLength } = encoded;
        // Simulate losing ONLY 1 data shard (within tolerance of 2 parity)
        const damagedShards = encoded.shards.map((shard, index) => {
            if (index === 0) {
                return Buffer.alloc(0); // lost 1 data shard
            }
            return shard;
        });
        const decoded = await decodeErasure(damagedShards, dataShards, parityShards, shardSize, originalLength);
        expect(decoded.toString()).toBe(data.toString());
    });
    it('should recover data when 1 parity shard is lost', async () => {
        const data = Buffer.from('Corruption test data for Reed-Solomon recovery');
        const networkSize = 50;
        const encoded = await encodeErasure(data, networkSize);
        const { dataShards, parityShards, shardSize, originalLength } = encoded;
        // Lose only 1 parity shard
        const damagedShards = encoded.shards.map((shard, index) => {
            if (index === dataShards) {
                return Buffer.alloc(0); // lost 1 parity shard
            }
            return shard;
        });
        const decoded = await decodeErasure(damagedShards, dataShards, parityShards, shardSize, originalLength);
        expect(decoded.toString()).toBe(data.toString());
    });
    it('should throw when too many shards are lost', async () => {
        const data = Buffer.from('Data that will be unrecoverable');
        const networkSize = 50;
        const encoded = await encodeErasure(data, networkSize);
        const { dataShards, parityShards, shardSize, originalLength } = encoded;
        // Lose more shards than parity can recover (3 > 2)
        const damagedShards = encoded.shards.map((shard, index) => {
            if (index < 3) {
                return Buffer.alloc(0);
            }
            return shard;
        });
        await expect(decodeErasure(damagedShards, dataShards, parityShards, shardSize, originalLength)).rejects.toThrow();
    });
});
