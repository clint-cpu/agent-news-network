#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startP2PNode, stopP2PNode } from '../dist/p2p.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ann-network-check-'));
process.env.ANN_IDENTITY_DIR = process.env.ANN_IDENTITY_DIR || tempDir;
process.env.ANN_DB_PATH = process.env.ANN_DB_PATH || path.join(tempDir, 'ledger.sqlite');

try {
  const node = await startP2PNode('full');
  await new Promise(resolve => setTimeout(resolve, Number(process.env.ANN_NETWORK_CHECK_WAIT_MS || 12000)));
  const connections = node.getConnections();

  console.log(`ANN network check: ${connections.length > 0 ? 'ok' : 'no peers connected'}`);
  console.log(`Peer ID: ${node.peerId.toString()}`);
  console.log(`Connections: ${connections.length}`);
  for (const connection of connections) {
    console.log(`- ${connection.remotePeer.toString()} ${connection.remoteAddr?.toString?.() ?? ''}`);
  }

  await stopP2PNode();
  process.exitCode = connections.length > 0 ? 0 : 1;
} finally {
  try {
    await stopP2PNode();
  } catch {}
  fs.rmSync(tempDir, { recursive: true, force: true });
}
