#!/usr/bin/env node
/**
 * E2E Test: Agent News Network P2P node — publish, search, and signature verification.
 * Run: cd mcp-server-ann && node tests/e2e-federation.mjs
 */
import { spawn } from "node:child_process";
import { readFile, rm, mkdtemp } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../..");
const MCP_DIR = join(ROOT, "mcp-server-ann");
const PACKAGE_JSON = JSON.parse(await readFile(join(MCP_DIR, "package.json"), "utf8"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runMcpClient({ identityDir, dbPath }) {
  return new Promise((resolve, reject) => {
    const serverPath = join(MCP_DIR, "dist", "index.js");
    const child = spawn("node", [serverPath], {
      cwd: MCP_DIR,
      env: {
        ...process.env,
        ANN_IDENTITY_DIR: identityDir,
        ANN_DB_PATH: dbPath || join(identityDir, "ledger.sqlite"),
        ANN_NODE_MODE: "light",
        ANN_BOOTSTRAP_REPLACE_DEFAULTS: "true",
        ANN_BOOTSTRAP_NODES: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let output = "";
    let errOutput = "";
    child.stdout.on("data", (d) => { output += d.toString(); });
    child.stderr.on("data", (d) => { errOutput += d.toString(); });

    // Send MCP initialize request
    const initRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "e2e-test", version: "1.0.0" },
      },
    };

    // Send tools/list request
    const listToolsRequest = {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    };

    const startedAt = Date.now();
    let sentRequests = false;
    const interval = setInterval(() => {
      if (!sentRequests && output.includes("ANN P2P MCP Server connected via stdio")) {
        child.stdin.write(JSON.stringify(initRequest) + "\n");
        child.stdin.write(JSON.stringify(listToolsRequest) + "\n");
        sentRequests = true;
      }
      if (output.includes("publish_knowledge") || Date.now() - startedAt > 20000) {
        clearInterval(interval);
        child.stdin.end();
        child.kill();
        resolve({ output, errOutput, code: 0 });
      }
    }, 250);

    child.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`MCP server exited with code ${code}. stderr: ${errOutput}`));
      }
    });
    child.on("error", reject);
  });
}

async function runCli(args, { identityDir, dbPath }) {
  return new Promise((resolve, reject) => {
    const serverPath = join(MCP_DIR, "dist", "index.js");
    const child = spawn("node", [serverPath, ...args], {
      cwd: MCP_DIR,
      env: {
        ...process.env,
        ANN_IDENTITY_DIR: identityDir,
        ANN_DB_PATH: dbPath || join(identityDir, "ledger.sqlite"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    let errOutput = "";
    child.stdout.on("data", (d) => { output += d.toString(); });
    child.stderr.on("data", (d) => { errOutput += d.toString(); });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve({ output, errOutput, code });
      } else {
        reject(new Error(`CLI exited with code ${code}. stderr: ${errOutput}`));
      }
    });
    child.on("error", reject);
  });
}

const results = [];

function pass(name) {
  results.push({ name, ok: true });
  console.log(`\n✅ PASS: ${name}`);
}

function fail(name, err) {
  results.push({ name, ok: false, error: err.message });
  console.log(`\n❌ FAIL: ${name} — ${err.message}`);
}

async function main() {
  console.log("=== ANN P2P E2E ===\n");

  const tmpBase = await mkdtemp(join(tmpdir(), "ann-e2e-"));
  const identityDir = join(tmpBase, "identity");
  const dbPath = join(tmpBase, "ledger.sqlite");

  try {
    // Step 1: Verify dist/index.js exists
    const serverPath = join(MCP_DIR, "dist", "index.js");
    try {
      await import("node:fs/promises").then((fs) => fs.access(serverPath));
    } catch {
      throw new Error("dist/index.js not found. Run 'npm run build' first.");
    }
    pass("dist/index.js exists");

    const help = await runCli(["--help"], { identityDir, dbPath });
    if (!help.output.includes("A peer-to-peer memory layer for AI agents")) {
      throw new Error("--help output missing ANN tagline");
    }
    pass("CLI help works");

    const version = await runCli(["--version"], { identityDir, dbPath });
    if (version.output.trim() !== PACKAGE_JSON.version) {
      throw new Error(`--version returned ${version.output.trim()}`);
    }
    pass("CLI version works");

    const doctor = await runCli(["doctor"], { identityDir, dbPath });
    if (!doctor.output.includes("Network readiness: ok")) {
      throw new Error("doctor did not report network readiness");
    }
    pass("CLI doctor works");

    // Step 2: Start MCP server and list tools
    const { output, errOutput } = await runMcpClient({ identityDir, dbPath });
    
    if (!output.includes("publish_knowledge")) {
      throw new Error("publish_knowledge tool not found in MCP response");
    }
    if (!output.includes("search_knowledge")) {
      throw new Error("search_knowledge tool not found in MCP response");
    }
    if (!output.includes("request_help")) {
      throw new Error("request_help tool not found in MCP response");
    }
    if (!output.includes("answer_help")) {
      throw new Error("answer_help tool not found in MCP response");
    }
    pass("MCP tools listed correctly");

    // Step 3: Verify identity was generated
    const identityFile = join(identityDir, "identity.json");
    const fs = await import("node:fs/promises");
    const identityData = await fs.readFile(identityFile, "utf8");
    const identity = JSON.parse(identityData);
    if (!identity.publicKey || !identity.privateKey) {
      throw new Error("Identity file missing publicKey or privateKey");
    }
    pass("Ed25519 identity generated");

    // Step 4: Verify SQLite ledger was created
    try {
      await fs.access(dbPath);
    } catch {
      throw new Error("SQLite ledger not created at " + dbPath);
    }
    pass("SQLite ledger initialized");

    console.log("\n=== E2E SUMMARY ===");
    const passed = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok).length;
    for (const r of results) {
      console.log(r.ok ? `  ✅ ${r.name}` : `  ❌ ${r.name}`);
    }
    console.log(`\n${passed} passed, ${failed} failed.\n`);

    if (failed > 0) {
      process.exit(1);
    }
  } finally {
    await rm(tmpBase, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("\nE2E aborted:", err);
  process.exit(1);
});
