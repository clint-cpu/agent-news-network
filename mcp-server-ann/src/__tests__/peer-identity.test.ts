import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, afterEach } from 'vitest';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { loadOrGeneratePeerPrivateKey, getPeerPrivateKeyPath } from '../peer-identity.js';

const previousIdentityDir = process.env.ANN_IDENTITY_DIR;
let tempDir: string | null = null;

afterEach(() => {
  if (previousIdentityDir === undefined) {
    delete process.env.ANN_IDENTITY_DIR;
  } else {
    process.env.ANN_IDENTITY_DIR = previousIdentityDir;
  }

  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe('libp2p peer identity persistence', () => {
  it('reuses the same private key and PeerID across loads', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ann-peer-identity-'));
    process.env.ANN_IDENTITY_DIR = tempDir;

    const firstKey = await loadOrGeneratePeerPrivateKey();
    const secondKey = await loadOrGeneratePeerPrivateKey();

    expect(peerIdFromPrivateKey(secondKey).toString()).toBe(peerIdFromPrivateKey(firstKey).toString());
    expect(fs.existsSync(getPeerPrivateKeyPath())).toBe(true);
  });

  it('stores the private key with owner-only permissions', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ann-peer-identity-'));
    process.env.ANN_IDENTITY_DIR = tempDir;

    await loadOrGeneratePeerPrivateKey();

    const mode = fs.statSync(getPeerPrivateKeyPath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
