import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import nacl from 'tweetnacl';
import fs from 'fs';
import path from 'path';
import os from 'os';
// We will test the actual identity module, but mock fs to avoid writing to ~/.ann
vi.mock('fs');
// Import after mocking
const { loadOrGenerateIdentity } = await import('../identity.js');
describe('Identity / Ed25519', () => {
    const mockDir = path.join(os.homedir(), '.ann');
    const mockFile = path.join(mockDir, 'identity.json');
    beforeEach(() => {
        vi.resetAllMocks();
        // @ts-ignore
        fs.existsSync.mockImplementation((p) => {
            if (p === mockFile || p === mockDir)
                return true;
            return false;
        });
        // @ts-ignore
        fs.mkdirSync.mockImplementation(() => { });
        // @ts-ignore
        fs.writeFileSync.mockImplementation(() => { });
        // @ts-ignore
        fs.chmodSync.mockImplementation(() => { });
        // @ts-ignore
        fs.readFileSync.mockImplementation((p) => {
            if (p === mockFile)
                return JSON.stringify({ publicKey: 'mock', privateKey: 'mock' });
            return '{}';
        });
    });
    afterEach(() => {
        vi.restoreAllMocks();
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
        const badSignature = new Uint8Array(64); // all zeros
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
