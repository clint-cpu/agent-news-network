#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { getDb, insertGlobalIndex, searchSimilarVectors, runGarbageCollection, insertPublishedCid } from "./db.js";
import { startP2PNode, encodeErasure, estimateNetworkSize, generateCID, decodeErasure, dhtQueryKeyword, dhtGetContent, indexToDHT, extractKeywords, getReputation, updateReputation, reputationWeight, contentMatchesDeclaredDomain, dhtSweepExpired } from "./p2p.js";
import { loadOrGenerateIdentity } from "./identity.js";
import nacl from 'tweetnacl';
import crypto from 'crypto';

const server = new Server({
    name: "agent-news-network",
    version: "2.0.0",
}, {
    capabilities: {
        tools: {}
    }
});

// Deterministic Hash-based Embedding (Fallback for local demo without API keys)
function generateEmbedding(text: string): number[] {
    const hash = crypto.createHash('sha256').update(text).digest();
    const vec: number[] = [];
    for (let i = 0; i < 32; i++) {
        // Normalize hash byte to [-1, 1]
        vec.push((hash[i] / 127.5) - 1.0);
    }
    return vec;
}

// Setup Tool Handlers
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "publish_knowledge",
                description: "Publish a new piece of knowledge to the P2P Agent News Network.",
                inputSchema: {
                    type: "object",
                    properties: {
                        title: { type: "string" },
                        content: { type: "string" },
                        related_cid: { type: "string", description: "Optional CID of a previous knowledge card to link updates (Dynamic Research Live)" },
                        status: { type: "string", enum: ["resolved", "partial", "failed"], description: "Status of the task/knowledge" },
                        artifacts: {
                            type: "array",
                            items: {
                                type: "object",
                                properties: {
                                    type: { type: "string" },
                                    body: { type: "string" },
                                    metrics: { type: "object" }
                                }
                            },
                            description: "Output artifacts or metrics of the task"
                        }
                    },
                    required: ["title", "content", "status"]
                }
            },
            {
                name: "search_knowledge",
                description: "Search for knowledge across the P2P network using semantic vector search.",
                inputSchema: {
                    type: "object",
                    properties: {
                        query: { type: "string" },
                    },
                    required: ["query"]
                }
            }
        ]
    };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    switch (request.params.name) {
        case "publish_knowledge": {
            let { title, content, status, artifacts = [], related_cid } = request.params.arguments as any;

            // Basic XSS/Content Safety Filtering
            if (typeof title === 'string') {
                title = title.replace(/<script/gi, '&lt;script').replace(/<iframe/gi, '&lt;iframe');
            }
            if (typeof content === 'string') {
                content = content.replace(/<script/gi, '&lt;script').replace(/<iframe/gi, '&lt;iframe');
            }

            // Input validation
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

            // Phase 4: Chunk and Encode the content
            const contentBuffer = Buffer.from(JSON.stringify({ content, status, artifacts, related_cid }), 'utf-8');
            const cid = generateCID(contentBuffer);
            const netSize = await estimateNetworkSize();
            
            const { shards } = await encodeErasure(contentBuffer, netSize);
            
            // Generate real embedding
            const vector = generateEmbedding(title + " " + content);
            
            // Use real identity for signing
            const identity = loadOrGenerateIdentity();
            const timestamp = Date.now();
            const expires_at = timestamp + 1000 * 60 * 60 * 24 * 30; // 30 days TTL

            // Standard ANP Signature Format: id = sha256([0, pubkey, created_at, kind, content_cid, related_cid])
            const kind = 1; // 1 = Knowledge Event
            const payloadArray = [0, identity.publicKey, timestamp, kind, cid, related_cid || null];
            const id = crypto.createHash('sha256').update(JSON.stringify(payloadArray)).digest('hex');
            const sig = Buffer.from(nacl.sign.detached(Buffer.from(id, 'hex'), Buffer.from(identity.privateKey, 'hex'))).toString('hex');

            const p2pNode = await startP2PNode('full');

            // Phase 3: Look up own reputation before publishing
            const declaredDomains = (process.env.ANN_CAPABILITY_DOMAINS || 'general')
                .split(',').map(d => d.trim().toLowerCase());
            const domainMatch = contentMatchesDeclaredDomain(title, content, declaredDomains);
            const ledgerBefore = await getReputation(p2pNode, identity.publicKey);
            const weightBefore = reputationWeight(ledgerBefore);

            // Publish index to gossipsub
            const indexPayload = JSON.stringify({
                id,
                sig,
                cid,
                title,
                author_pubkey: identity.publicKey,
                kind,
                status,
                related_cid,
                artifacts,
                vector_json: JSON.stringify(vector),
                timestamp,
                expires_at,
                _rep_weight: weightBefore
            });
            await p2pNode.services.pubsub.publish('ann-global-index', new TextEncoder().encode(indexPayload));

            // Also insert into local DB so the publishing node can search its own content immediately
            await insertPublishedCid(cid, expires_at);
            await insertGlobalIndex({
              cid,
              title,
              author_pubkey: identity.publicKey,
              signature: sig,
              vector_json: JSON.stringify(vector),
              status,
              related_cid: related_cid || null,
              artifacts,
              timestamp,
              expires_at,
              _rep_weight: weightBefore,
            });

            // Phase 3: Update own reputation after successful publish
            // This uses the local node reference to write to DHT
            await updateReputation(p2pNode, identity.publicKey, domainMatch, declaredDomains);
            const ledgerAfter = await getReputation(p2pNode, identity.publicKey);
            console.log(`[Reputation] Published by ${identity.publicKey.slice(0, 8)}: domain_match=${domainMatch}, new_weight=${reputationWeight(ledgerAfter)}x, total_score=${ledgerAfter.total_score}`);

            // DHT: write content blob + keyword reverse index (Phase 1 dual-key DHT)
            if (p2pNode.services.dht) {
                await indexToDHT(p2pNode, cid, title, content, {
                    id,
                    sig,
                    cid,
                    title,
                    author_pubkey: identity.publicKey,
                    kind,
                    status,
                    related_cid,
                    artifacts,
                    vector_json: JSON.stringify(vector),
                    timestamp,
                    expires_at
                }, expires_at);
            }
            
            return {
                content: [{ type: "text", text: `Successfully published knowledge to P2P network.\nCID: ${cid}\nAuthor: ${identity.publicKey}\nShards generated and put to DHT: ${shards.length}` }]
            };
        }
        case "search_knowledge": {
            const { query } = request.params.arguments as any;

            if (typeof query !== 'string' || query.length === 0 || query.length > 1000) {
                throw new Error('query must be a non-empty string of at most 1000 characters');
            }

            const queryVector = generateEmbedding(query);
            const p2pNode = await startP2PNode('full');

            // Step 1: Local SQLite vector similarity search
            const localResults = await searchSimilarVectors(queryVector, 10);

            // Step 2: Extract keywords from query and search DHT keyword index
            const queryKeywords = extractKeywords(query, '');
            const remoteCids = new Set<string>();
            const keywordCidMap = new Map<string, string[]>(); // keyword -> cids found

            if (p2pNode.services.dht && queryKeywords.length > 0) {
                // Query DHT index for each keyword in parallel
                const dhtQueryResults = await Promise.all(
                    queryKeywords.map(kw => dhtQueryKeyword(p2pNode, kw).then(cids => ({ kw, cids })))
                );
                for (const { kw, cids } of dhtQueryResults) {
                    if (cids.length > 0) {
                        keywordCidMap.set(kw, cids);
                        for (const cid of cids) {
                            // Filter out cids already in local results to avoid duplicates
                            if (!localResults.find(r => r.cid === cid)) {
                                remoteCids.add(cid);
                            }
                        }
                    }
                }
            }

            // Step 3: Fetch remote content from DHT and compute similarity scores
            const remoteResults: any[] = [];
            if (p2pNode.services.dht && remoteCids.size > 0) {
                await Promise.all(
                    Array.from(remoteCids).map(async (cid) => {
                        const item = await dhtGetContent(p2pNode, cid);
                        if (!item) return;
                        // Compute vector similarity score for ranking
                        const vec = JSON.parse(item.vector_json || '[]') as number[];
                        let dotProduct = 0;
                        for (let i = 0; i < Math.min(vec.length, queryVector.length); i++) {
                            dotProduct += vec[i] * queryVector[i];
                        }
                        remoteResults.push({ ...item, score: dotProduct, _source: 'dht' });
                    })
                );
            }

            // Step 4: Merge and sort by score descending
            const allResults = [
                ...localResults.map(r => ({ ...r, score: r.score ?? 0, _source: 'local' })),
                ...remoteResults
            ];
            allResults.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

            const summary = allResults.length === 0
                ? `No results found for "${query}".`
                : `Found ${allResults.length} result(s) for "${query}":\n` +
                  allResults.map((r, i) =>
                      `[${i + 1}] score=${(r.score ?? 0).toFixed(4)} source=${r._source} title="${r.title}" cid=${r.cid.slice(0, 16)}…`
                  ).join('\n');

            return {
                content: [{ type: "text", text: summary }]
            };
        }
        default:
            throw new Error(`Unknown tool: ${request.params.name}`);
    }
});

async function main() {
    const isBootstrapMode = process.argv.includes('--bootstrap');

    if (isBootstrapMode) {
        console.log("Starting ANN in Dedicated Bootstrap Mode...");
        process.env.ANN_BOOTSTRAP_LISTEN = process.env.ANN_BOOTSTRAP_LISTEN || '/ip4/0.0.0.0/tcp/41230/ws';
        await getDb();
        const node = await startP2PNode('full');
        console.log(`Bootstrap Node running. PeerID: ${node.peerId.toString()}`);
        console.log(`Listening on: ${node.getMultiaddrs().map(a => a.toString()).join(', ')}`);
        
        setInterval(() => {
            runGarbageCollection().catch(console.error);
            dhtSweepExpired(node).catch(console.error);
        }, 1000 * 60 * 60);
        return; // Do not start MCP server
    }

    console.log("Starting ANN P2P MCP Server...");
    
    // Initialize P2P & DB
    await getDb();
    await startP2PNode();
    
    // Start Garbage Collection loop
    setInterval(() => {
        runGarbageCollection().catch(console.error);
        startP2PNode('full').then(n => dhtSweepExpired(n)).catch(console.error);
    }, 1000 * 60 * 60);
    
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.log("ANN P2P MCP Server connected via stdio");
}

main().catch(console.error);
