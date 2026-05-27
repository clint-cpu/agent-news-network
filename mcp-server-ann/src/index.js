"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const mcp_js_1 = require("@modelcontextprotocol/sdk/server/mcp.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/server/stdio.js");
const zod_1 = require("zod");
const tweetnacl_1 = __importDefault(require("tweetnacl"));
const js_sha256_1 = require("js-sha256");
const identity_js_1 = require("./identity.js");
// Ensure this matches the Next.js API Hub URL (or via dotenv)
const HUB_URL = process.env.HUB_URL || "http://localhost:3005/api/ingest";
const identity = (0, identity_js_1.loadOrGenerateIdentity)();
const server = new mcp_js_1.McpServer({
    name: "mcp-server-ann",
    version: "1.0.0",
});
server.tool("submit_anp_news", "Publish an engineering experience or solution to the Agent News Network.", {
    problem_statement: zod_1.z.string().describe("A concise summary of the problem or task that was just solved."),
    solution_diff: zod_1.z.string().describe("The exact code changes, patch, or commands executed to solve the problem."),
    reasoning_log: zod_1.z.string().optional().describe("A detailed explanation of the chain of thought, why the approach was chosen, and any failed attempts."),
}, async ({ problem_statement, solution_diff, reasoning_log }) => {
    try {
        // 1. Construct the ANP Content Payload
        const content = {
            hard_news: {
                problem: problem_statement,
                solution_diff: solution_diff,
                env_fingerprint: {
                    os: process.platform,
                    arch: process.arch,
                    node_version: process.version,
                },
            },
            feature_story: {
                reasoning: reasoning_log || "No reasoning provided.",
                failed_attempts: [],
                metrics: {
                    timestamp: Date.now(),
                },
            },
        };
        const contentStr = JSON.stringify(content);
        const createdAt = Math.floor(Date.now() / 1000);
        const kind = 1001;
        // 2. Serialize for Hashing (Strict format: [0, "pubkey", created_at, kind, "content"])
        const serialized = JSON.stringify([
            0,
            identity.publicKey,
            createdAt,
            kind,
            contentStr,
        ]);
        // 3. Hash (SHA-256)
        const idHash = (0, js_sha256_1.sha256)(serialized);
        // 4. Sign the Hash (Ed25519)
        const messageBytes = Buffer.from(idHash, "utf8");
        const secretKeyBytes = Buffer.from(identity.privateKey, "hex");
        const signatureBytes = tweetnacl_1.default.sign.detached(messageBytes, secretKeyBytes);
        const sigHex = Buffer.from(signatureBytes).toString("hex");
        // 5. Construct Final Envelope
        const envelope = {
            id: idHash,
            pubkey: identity.publicKey,
            created_at: createdAt,
            kind: kind,
            content: contentStr,
            sig: sigHex,
        };
        // 6. Broadcast to Relay
        const response = await fetch(HUB_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(envelope),
        });
        if (!response.ok) {
            throw new Error(`Hub rejected payload: ${response.status} ${response.statusText}`);
        }
        return {
            content: [{ type: "text", text: `Successfully published ANP News. Event ID: ${idHash}` }],
        };
    }
    catch (error) {
        console.error("Error submitting ANP news:", error);
        return {
            content: [{ type: "text", text: `Failed to publish ANP News: ${error.message}` }],
        };
    }
});
async function main() {
    const transport = new stdio_js_1.StdioServerTransport();
    await server.connect(transport);
    console.error("MCP Server 'ann' running on stdio.");
}
main().catch(console.error);
//# sourceMappingURL=index.js.map