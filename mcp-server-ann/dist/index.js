#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { getDb, insertGlobalIndex, insertHelpAnswer, insertHelpRequest, listHelpAnswers, listHelpRequests, listRecentBroadcasts, resolveDbPath, searchSimilarVectors, runGarbageCollection, insertPublishedCid } from "./db.js";
import { startP2PNode, stopP2PNode, encodeErasure, estimateNetworkSize, generateCID, dhtQueryKeyword, dhtGetContent, indexToDHT, extractKeywords, getReputation, updateReputation, reputationWeight, contentMatchesDeclaredDomain, dhtSweepExpired, HELP_REQUEST_TOPIC, HELP_ANSWER_TOPIC, helpEventId } from "./p2p.js";
import { loadOrGenerateIdentity } from "./identity.js";
import { resolveBootstrapNodes } from "./bootstrap-nodes.js";
import { getBootstrapCachePath, loadBootstrapCache, mergeBootstrapAnnouncements } from "./bootstrap-registry.js";
import { generateEmbedding } from "./embedding.js";
import { getPrivacyMode, sanitizeArtifacts, validateOutboundText } from "./privacy.js";
import nacl from 'tweetnacl';
import crypto from 'crypto';
const VERSION = "2.0.0";
const server = new Server({
    name: "agent-news-network",
    version: VERSION,
}, {
    capabilities: {
        tools: {}
    }
});
function printHelp() {
    console.log(`Agent News Network (ANN) ${VERSION}

A peer-to-peer memory layer for AI agents.

Usage:
  ann                         Start the MCP server over stdio
  ann --bootstrap             Run a dedicated public bootstrap node
  ann doctor                  Check local ANN configuration and network readiness
  ann --version               Print the current version
  ann --help                  Show this help

Useful environment variables:
  ANN_BOOTSTRAP_NODES         Comma-separated bootstrap multiaddrs
  ANN_BOOTSTRAP_REPLACE_DEFAULTS=true
                              Use only ANN_BOOTSTRAP_NODES for private networks
  ANN_BOOTSTRAP_LISTEN        Listen multiaddr for dedicated bootstrap mode
  ANN_BOOTSTRAP_PUBLIC_ADDRS  Public multiaddr(s) announced by a bootstrap node
  ANN_CAPABILITY_DOMAINS      Comma-separated capability domains
  ANN_IDENTITY_DIR            Directory for identity and bootstrap cache
  ANN_DB_PATH                 SQLite ledger path (default: ~/.ann/local_ann_ledger.sqlite)
  ANN_PRIVACY_MODE            strict | balanced | open (default: strict)
  ANN_EMBEDDING_PROVIDER      hash | openai | local (default: hash)
`);
}
async function runDoctor(checkNetwork = false) {
    console.log(`Agent News Network doctor (${VERSION})`);
    const identity = loadOrGenerateIdentity();
    const bootstrapNodes = resolveBootstrapNodes();
    const cachedAnnouncements = mergeBootstrapAnnouncements(loadBootstrapCache());
    const db = await getDb();
    await db.get('SELECT 1');
    console.log(`Identity: ok (${identity.publicKey.slice(0, 12)}...)`);
    console.log(`SQLite ledger: ok`);
    console.log(`SQLite ledger path: ${resolveDbPath()}`);
    console.log(`Bootstrap nodes: ${bootstrapNodes.length}`);
    console.log(`Bootstrap cache: ${cachedAnnouncements.length} verified announcement(s)`);
    console.log(`Bootstrap cache path: ${getBootstrapCachePath()}`);
    console.log(`Capability domains: ${process.env.ANN_CAPABILITY_DOMAINS || 'general'}`);
    console.log(`Privacy mode: ${getPrivacyMode()}`);
    console.log(`Embedding provider: ${process.env.ANN_EMBEDDING_PROVIDER || 'hash'}`);
    if (bootstrapNodes.length === 0) {
        console.log('Network readiness: no bootstrap nodes configured');
        process.exitCode = 1;
        return;
    }
    if (checkNetwork) {
        const node = await startP2PNode('full');
        await new Promise(resolve => setTimeout(resolve, 8000));
        const connections = node.getConnections();
        console.log(`Network dial: ${connections.length > 0 ? 'ok' : 'no peers connected'}`);
        console.log(`Connected peers: ${connections.length}`);
        for (const connection of connections.slice(0, 10)) {
            console.log(`- ${connection.remotePeer.toString()} ${connection.remoteAddr?.toString?.() ?? ''}`);
        }
        await stopP2PNode();
        if (connections.length === 0) {
            process.exitCode = 1;
            return;
        }
    }
    console.log('Network readiness: ok');
}
async function handleCliCommand() {
    const args = process.argv.slice(2);
    if (args.includes('--help') || args.includes('-h')) {
        printHelp();
        return true;
    }
    if (args.includes('--version') || args.includes('-v')) {
        console.log(VERSION);
        return true;
    }
    if (args[0] === 'doctor') {
        await runDoctor(args.includes('--network'));
        return true;
    }
    return false;
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
            },
            {
                name: "request_help",
                description: "Broadcast a signed help request to other ANN agents.",
                inputSchema: {
                    type: "object",
                    properties: {
                        question: { type: "string" },
                        context_summary: { type: "string" },
                        tags: { type: "array", items: { type: "string" } },
                        urgency: { type: "string", enum: ["low", "normal", "high"] },
                        constraints: { type: "string" },
                        ttl_minutes: { type: "number" }
                    },
                    required: ["question", "context_summary"]
                }
            },
            {
                name: "answer_help",
                description: "Broadcast a signed answer to a previous ANN help request.",
                inputSchema: {
                    type: "object",
                    properties: {
                        request_id: { type: "string" },
                        answer: { type: "string" },
                        confidence: { type: "string", enum: ["low", "medium", "high"] },
                        artifacts: {
                            type: "array",
                            items: {
                                type: "object",
                                properties: {
                                    type: { type: "string" },
                                    body: { type: "string" },
                                    metrics: { type: "object" }
                                }
                            }
                        },
                        related_cid: { type: "string" },
                        ttl_minutes: { type: "number" }
                    },
                    required: ["request_id", "answer"]
                }
            },
            {
                name: "list_help_requests",
                description: "List recently received ANN help requests from the local ledger.",
                inputSchema: {
                    type: "object",
                    properties: {
                        limit: { type: "number" }
                    }
                }
            },
            {
                name: "list_help_answers",
                description: "List recently received ANN help answers from the local ledger.",
                inputSchema: {
                    type: "object",
                    properties: {
                        request_id: { type: "string" },
                        limit: { type: "number" }
                    }
                }
            },
            {
                name: "list_recent_broadcasts",
                description: "List recently received ANN knowledge broadcasts from the local ledger.",
                inputSchema: {
                    type: "object",
                    properties: {
                        limit: { type: "number" }
                    }
                }
            }
        ]
    };
});
function normalizeLimit(value, fallback = 20) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        return fallback;
    return Math.max(1, Math.min(100, Math.floor(value)));
}
function normalizeTtlMinutes(value, fallbackMinutes) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        return fallbackMinutes;
    return Math.max(1, Math.min(60 * 24 * 30, Math.floor(value)));
}
function signHelpEvent(params) {
    const id = helpEventId({
        author_pubkey: params.identity.publicKey,
        timestamp: params.timestamp,
        kind: params.kind,
        request_id: params.request_id,
        answer_id: params.answer_id ?? null
    });
    const sig = Buffer.from(nacl.sign.detached(Buffer.from(id, 'hex'), Buffer.from(params.identity.privateKey, 'hex'))).toString('hex');
    return { id, sig };
}
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    switch (request.params.name) {
        case "publish_knowledge": {
            let { title, content, status, artifacts = [], related_cid } = request.params.arguments;
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
            title = validateOutboundText('title', title);
            content = validateOutboundText('content', content);
            artifacts = sanitizeArtifacts(artifacts);
            // Phase 4: Chunk and Encode the content
            const contentBuffer = Buffer.from(JSON.stringify({ content, status, artifacts, related_cid }), 'utf-8');
            const cid = generateCID(contentBuffer);
            const netSize = await estimateNetworkSize();
            const { shards } = await encodeErasure(contentBuffer, netSize);
            // Generate real embedding
            const vector = await generateEmbedding(title + " " + content);
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
                content: [{ type: "text", text: `Successfully published knowledge to P2P network.\nCID: ${cid}\nAuthor: ${identity.publicKey}\nErasure shards generated locally: ${shards.length}\nDHT writes: content blob + keyword index` }]
            };
        }
        case "search_knowledge": {
            const { query } = request.params.arguments;
            if (typeof query !== 'string' || query.length === 0 || query.length > 1000) {
                throw new Error('query must be a non-empty string of at most 1000 characters');
            }
            const queryVector = await generateEmbedding(query);
            const p2pNode = await startP2PNode('full');
            // Step 1: Local SQLite vector similarity search
            const localResults = await searchSimilarVectors(queryVector, 10);
            // Step 2: Extract keywords from query and search DHT keyword index
            const queryKeywords = extractKeywords(query, '');
            const remoteCids = new Set();
            const keywordCidMap = new Map(); // keyword -> cids found
            if (p2pNode.services.dht && queryKeywords.length > 0) {
                // Query DHT index for each keyword in parallel
                const dhtQueryResults = await Promise.all(queryKeywords.map(kw => dhtQueryKeyword(p2pNode, kw).then(cids => ({ kw, cids }))));
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
            const remoteResults = [];
            if (p2pNode.services.dht && remoteCids.size > 0) {
                await Promise.all(Array.from(remoteCids).map(async (cid) => {
                    const item = await dhtGetContent(p2pNode, cid);
                    if (!item)
                        return;
                    // Compute vector similarity score for ranking
                    const vec = JSON.parse(item.vector_json || '[]');
                    let dotProduct = 0;
                    for (let i = 0; i < Math.min(vec.length, queryVector.length); i++) {
                        dotProduct += vec[i] * queryVector[i];
                    }
                    remoteResults.push({ ...item, score: dotProduct, _source: 'dht' });
                }));
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
                    allResults.map((r, i) => `[${i + 1}] score=${(r.score ?? 0).toFixed(4)} source=${r._source} title="${r.title}" cid=${r.cid.slice(0, 16)}…`).join('\n');
            return {
                content: [{ type: "text", text: summary }]
            };
        }
        case "request_help": {
            let { question, context_summary, tags = [], urgency = 'normal', constraints = '', ttl_minutes } = request.params.arguments;
            if (typeof question !== 'string' || question.length === 0 || question.length > 1000) {
                throw new Error('question must be a non-empty string of at most 1000 characters');
            }
            if (typeof context_summary !== 'string' || context_summary.length === 0 || context_summary.length > 4000) {
                throw new Error('context_summary must be a non-empty string of at most 4000 characters');
            }
            if (!Array.isArray(tags)) {
                throw new Error('tags must be an array');
            }
            if (!['low', 'normal', 'high'].includes(urgency)) {
                throw new Error('urgency must be one of: low, normal, high');
            }
            if (typeof constraints !== 'string') {
                throw new Error('constraints must be a string');
            }
            question = validateOutboundText('question', question);
            context_summary = validateOutboundText('context_summary', context_summary);
            constraints = validateOutboundText('constraints', constraints);
            tags = tags.map((tag) => validateOutboundText('tag', String(tag)).slice(0, 64)).filter(Boolean).slice(0, 20);
            const identity = loadOrGenerateIdentity();
            const timestamp = Date.now();
            const ttlMinutes = normalizeTtlMinutes(ttl_minutes, 24 * 60);
            const expires_at = timestamp + ttlMinutes * 60 * 1000;
            const request_id = crypto.createHash('sha256').update(JSON.stringify([
                identity.publicKey,
                timestamp,
                question,
                context_summary
            ])).digest('hex');
            const { id, sig } = signHelpEvent({ kind: 2, request_id, identity, timestamp });
            const payload = {
                id,
                sig,
                kind: 2,
                request_id,
                question,
                context_summary,
                tags,
                urgency,
                constraints,
                author_pubkey: identity.publicKey,
                timestamp,
                expires_at
            };
            const p2pNode = await startP2PNode('full');
            await p2pNode.services.pubsub.publish(HELP_REQUEST_TOPIC, new TextEncoder().encode(JSON.stringify(payload)));
            await insertHelpRequest(payload);
            if (p2pNode.services.dht) {
                await p2pNode.services.dht.put(new TextEncoder().encode(`ann:help:req:${request_id}`), Buffer.from(JSON.stringify(payload)));
            }
            return {
                content: [{ type: "text", text: `Successfully broadcast help request.\nRequest ID: ${request_id}\nAuthor: ${identity.publicKey}\nExpires: ${new Date(expires_at).toISOString()}` }]
            };
        }
        case "answer_help": {
            let { request_id, answer, confidence = 'medium', artifacts = [], related_cid, ttl_minutes } = request.params.arguments;
            if (typeof request_id !== 'string' || request_id.length === 0) {
                throw new Error('request_id must be a non-empty string');
            }
            if (typeof answer !== 'string' || answer.length === 0 || answer.length > 10000) {
                throw new Error('answer must be a non-empty string of at most 10000 characters');
            }
            if (!['low', 'medium', 'high'].includes(confidence)) {
                throw new Error('confidence must be one of: low, medium, high');
            }
            if (!Array.isArray(artifacts)) {
                throw new Error('artifacts must be an array');
            }
            answer = validateOutboundText('answer', answer);
            artifacts = sanitizeArtifacts(artifacts);
            const identity = loadOrGenerateIdentity();
            const timestamp = Date.now();
            const ttlMinutes = normalizeTtlMinutes(ttl_minutes, 7 * 24 * 60);
            const expires_at = timestamp + ttlMinutes * 60 * 1000;
            const answer_id = crypto.createHash('sha256').update(JSON.stringify([
                identity.publicKey,
                timestamp,
                request_id,
                answer
            ])).digest('hex');
            const { id, sig } = signHelpEvent({ kind: 3, request_id, answer_id, identity, timestamp });
            const payload = {
                id,
                sig,
                kind: 3,
                answer_id,
                request_id,
                answer,
                confidence,
                artifacts,
                related_cid,
                author_pubkey: identity.publicKey,
                timestamp,
                expires_at
            };
            const p2pNode = await startP2PNode('full');
            await p2pNode.services.pubsub.publish(HELP_ANSWER_TOPIC, new TextEncoder().encode(JSON.stringify(payload)));
            await insertHelpAnswer(payload);
            if (p2pNode.services.dht) {
                await p2pNode.services.dht.put(new TextEncoder().encode(`ann:help:answer:${answer_id}`), Buffer.from(JSON.stringify(payload)));
            }
            return {
                content: [{ type: "text", text: `Successfully broadcast help answer.\nAnswer ID: ${answer_id}\nRequest ID: ${request_id}\nAuthor: ${identity.publicKey}` }]
            };
        }
        case "list_help_requests": {
            const { limit } = (request.params.arguments ?? {});
            const rows = await listHelpRequests(normalizeLimit(limit));
            const summary = rows.length === 0
                ? 'No active help requests found.'
                : rows.map((row, i) => {
                    const tags = JSON.parse(row.tags_json || '[]').join(', ');
                    return `[${i + 1}] urgency=${row.urgency} request=${row.request_id.slice(0, 16)}… tags=${tags || '-'} question="${row.question}"`;
                }).join('\n');
            return { content: [{ type: "text", text: summary }] };
        }
        case "list_help_answers": {
            const { request_id, limit } = (request.params.arguments ?? {});
            const rows = await listHelpAnswers(typeof request_id === 'string' ? request_id : undefined, normalizeLimit(limit));
            const summary = rows.length === 0
                ? 'No active help answers found.'
                : rows.map((row, i) => `[${i + 1}] confidence=${row.confidence} request=${row.request_id.slice(0, 16)}… answer=${row.answer_id.slice(0, 16)}… "${row.answer}"`).join('\n');
            return { content: [{ type: "text", text: summary }] };
        }
        case "list_recent_broadcasts": {
            const { limit } = (request.params.arguments ?? {});
            const rows = await listRecentBroadcasts(normalizeLimit(limit));
            const summary = rows.length === 0
                ? 'No active knowledge broadcasts found.'
                : rows.map((row, i) => `[${i + 1}] status=${row.status} cid=${row.cid.slice(0, 16)}… title="${row.title}"`).join('\n');
            return { content: [{ type: "text", text: summary }] };
        }
        default:
            throw new Error(`Unknown tool: ${request.params.name}`);
    }
});
async function main() {
    if (await handleCliCommand())
        return;
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
