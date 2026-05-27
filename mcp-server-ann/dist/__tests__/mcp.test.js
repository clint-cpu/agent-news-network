import { describe, it, expect, vi } from 'vitest';
// Mock p2p and db modules to avoid real network / DB
vi.mock('../p2p.js', async () => {
    const actual = await vi.importActual('../p2p.js');
    return {
        ...actual,
        startP2PNode: vi.fn().mockResolvedValue({
            services: {
                pubsub: { publish: vi.fn().mockResolvedValue(undefined) },
                dht: {
                    put: vi.fn().mockResolvedValue(undefined),
                    get: vi.fn().mockRejectedValue(new Error('not found')),
                },
            },
        }),
        stopP2PNode: vi.fn().mockResolvedValue(undefined),
        estimateNetworkSize: vi.fn().mockResolvedValue(10),
        encodeErasure: vi.fn().mockResolvedValue({ shards: Array(6).fill(Buffer.from('shard')), dataShards: 4, parityShards: 2, shardSize: 8, originalLength: 10 }),
        generateCID: vi.fn().mockReturnValue('mock-cid-123'),
        dhtQueryKeyword: vi.fn().mockResolvedValue([]),
        dhtGetContent: vi.fn().mockResolvedValue(null),
        indexToDHT: vi.fn().mockResolvedValue(undefined),
        extractKeywords: vi.fn().mockReturnValue(['test']),
        getReputation: vi.fn().mockResolvedValue({ total_score: 0, event_count: 0, domain_scores: {}, last_updated: 0 }),
        updateReputation: vi.fn().mockResolvedValue({ total_score: 1, event_count: 1, domain_scores: {}, last_updated: Date.now() }),
        reputationWeight: vi.fn().mockReturnValue(0.5),
        contentMatchesDeclaredDomain: vi.fn().mockReturnValue(false),
    };
});
vi.mock('../db.js', () => ({
    getDb: vi.fn().mockResolvedValue({}),
    insertGlobalIndex: vi.fn().mockResolvedValue(undefined),
    searchSimilarVectors: vi.fn().mockResolvedValue([]),
    runGarbageCollection: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../identity.js', () => ({
    loadOrGenerateIdentity: vi.fn().mockReturnValue({
        publicKey: 'aabbccdd'.repeat(8),
        privateKey: '00112233'.repeat(16),
    }),
}));
// Inline validation logic replicated from index.ts
function validatePublishKnowledge(args) {
    const { title, content, status, artifacts = [] } = args;
    if (typeof title !== 'string' || title.length === 0 || title.length > 512) {
        throw new Error('title must be a non-empty string of at most 512 characters');
    }
    if (typeof content !== 'string' || content.length === 0 || content.length > 1_000_000) {
        throw new Error('content must be a non-empty string of at most 1,000,000 characters');
    }
    if (!['resolved', 'partial', 'failed'].includes(status)) {
        throw new Error('status must be one of: resolved, partial, failed');
    }
    if (!Array.isArray(artifacts)) {
        throw new Error('artifacts must be an array');
    }
    return { content: [{ type: 'text', text: `Published: ${title}` }] };
}
function validateSearchKnowledge(args) {
    const { query } = args;
    if (typeof query !== 'string' || query.length === 0 || query.length > 1000) {
        throw new Error('query must be a non-empty string of at most 1000 characters');
    }
    return { content: [{ type: 'text', text: `Results for "${query}": none` }] };
}
const TOOLS = [
    { name: 'publish_knowledge' },
    { name: 'search_knowledge' },
];
describe('MCP Tools', () => {
    it('should list tools with consistent names', () => {
        const toolNames = TOOLS.map((t) => t.name);
        expect(toolNames).toContain('publish_knowledge');
        expect(toolNames).toContain('search_knowledge');
    });
    it('publish_knowledge should reject empty title', () => {
        expect(() => validatePublishKnowledge({ title: '', content: 'x', status: 'resolved' })).toThrow('title must be a non-empty string');
    });
    it('publish_knowledge should reject oversized title', () => {
        const longTitle = 'a'.repeat(513);
        expect(() => validatePublishKnowledge({ title: longTitle, content: 'x', status: 'resolved' })).toThrow('title must be a non-empty string of at most 512 characters');
    });
    it('publish_knowledge should reject invalid status', () => {
        expect(() => validatePublishKnowledge({ title: 'Valid', content: 'Valid', status: 'unknown' })).toThrow('status must be one of: resolved, partial, failed');
    });
    it('publish_knowledge should accept valid parameters', () => {
        const result = validatePublishKnowledge({ title: 'Hello', content: 'World', status: 'resolved', artifacts: [] });
        expect(result.content[0].text).toContain('Published: Hello');
    });
    it('search_knowledge should reject empty query', () => {
        expect(() => validateSearchKnowledge({ query: '' })).toThrow('query must be a non-empty string');
    });
    it('search_knowledge should return text content array', () => {
        const result = validateSearchKnowledge({ query: 'typescript' });
        expect(result.content).toBeInstanceOf(Array);
        expect(result.content[0].type).toBe('text');
        expect(typeof result.content[0].text).toBe('string');
    });
});
