import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import nacl from 'tweetnacl';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { loadOrGenerateIdentity } from '../identity.js';

describe('Identity / Ed25519', () => {
  const previousIdentityDir = process.env.ANN_IDENTITY_DIR;
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ann-identity-'));
    process.env.ANN_IDENTITY_DIR = tempDir;
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (previousIdentityDir === undefined) {
      delete process.env.ANN_IDENTITY_DIR;
    } else {
      process.env.ANN_IDENTITY_DIR = previousIdentityDir;
    }
  });

  it('should generate Ed25519 keypair with correct hex format', () => {
    const identity = loadOrGenerateIdentity();

    expect(identity.publicKey).toBeDefined();
    expect(identity.privateKey).toBeDefined();
    expect(identity.publicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(identity.privateKey).toMatch(/^[0-9a-f]{128}$/);
  });

  it('should generate valid Ed25519 keypair that can sign and verify', () => {
    const identity = loadOrGenerateIdentity();

    const pubkeyBytes = Buffer.from(identity.publicKey, 'hex');
    const secretBytes = Buffer.from(identity.privateKey, 'hex');

    const message = Buffer.from('hello ann');
    const signature = nacl.sign.detached(message, secretBytes);
    const valid = nacl.sign.detached.verify(message, signature, pubkeyBytes);

    expect(valid).toBe(true);
  });

  it('should reject invalid signature', () => {
    const identity = loadOrGenerateIdentity();

    const pubkeyBytes = Buffer.from(identity.publicKey, 'hex');
    const message = Buffer.from('hello ann');
    const badSignature = new Uint8Array(64);

    const valid = nacl.sign.detached.verify(message, badSignature, pubkeyBytes);
    expect(valid).toBe(false);
  });

  it('should fail verification when message is tampered', () => {
    const identity = loadOrGenerateIdentity();

    const pubkeyBytes = Buffer.from(identity.publicKey, 'hex');
    const secretBytes = Buffer.from(identity.privateKey, 'hex');

    const message = Buffer.from('hello ann');
    const signature = nacl.sign.detached(message, secretBytes);

    const tampered = Buffer.from('hello evil');
    const valid = nacl.sign.detached.verify(tampered, signature, pubkeyBytes);

    expect(valid).toBe(false);
  });
});
