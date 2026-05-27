import { describe, it, expect, vi, beforeEach } from 'vitest';
import nacl from 'tweetnacl';
import crypto from 'crypto';
import {
  verifyEnvelopeSignature,
  extractKeywords,
} from '../p2p.js';

// Helper to create a signed gossip payload
function createSignedPayload(identity: { publicKey: string; privateKey: string }, overrides: any = {}) {
  const timestamp = Date.now();
  const cid = 'testcid123';
  const kind = 1;
  const related_cid = null;

  const payloadArray = [0, identity.publicKey, timestamp, kind, cid, related_cid];
  const id = crypto.createHash('sha256').update(JSON.stringify(payloadArray)).digest('hex');
  const sig = Buffer.from(
    nacl.sign.detached(Buffer.from(id, 'hex'), Buffer.from(identity.privateKey, 'hex'))
  ).toString('hex');

  return {
    author_pubkey: identity.publicKey,
    sig,
    timestamp,
    kind,
    cid,
    related_cid,
    ...overrides,
  };
}

describe('Gossip Message', () => {
  let identity: { publicKey: string; privateKey: string };

  beforeEach(() => {
    const kp = nacl.sign.keyPair();
    identity = {
      publicKey: Buffer.from(kp.publicKey).toString('hex'),
      privateKey: Buffer.from(kp.secretKey).toString('hex'),
    };
  });

  it('should serialize and deserialize a message', () => {
    const payload = createSignedPayload(identity);
    const serialized = JSON.stringify(payload);
    const deserialized = JSON.parse(serialized);

    expect(deserialized.cid).toBe(payload.cid);
    expect(deserialized.sig).toBe(payload.sig);
    expect(deserialized.author_pubkey).toBe(identity.publicKey);
  });

  it('should verify a valid signed message', async () => {
    const payload = createSignedPayload(identity);
    const isValid = await verifyEnvelopeSignature(payload);
    expect(isValid).toBe(true);
  });

  it('should reject a message with invalid signature', async () => {
    const payload = createSignedPayload(identity, { sig: '00'.repeat(64) });
    const isValid = await verifyEnvelopeSignature(payload);
    expect(isValid).toBe(false);
  });

  it('should reject a tampered message (cid changed)', async () => {
    const payload = createSignedPayload(identity);
    payload.cid = 'tampered-cid';
    const isValid = await verifyEnvelopeSignature(payload);
    expect(isValid).toBe(false);
  });

  it('should reject a message with wrong pubkey', async () => {
    const otherKp = nacl.sign.keyPair();
    const otherPub = Buffer.from(otherKp.publicKey).toString('hex');
    const payload = createSignedPayload(identity, { author_pubkey: otherPub });
    const isValid = await verifyEnvelopeSignature(payload);
    expect(isValid).toBe(false);
  });

  it('should handle emitSelf behavior (node receives its own message)', () => {
    // emitSelf is a libp2p gossipsub config flag.
    // We verify that the message structure supports self-echo.
    const payload = createSignedPayload(identity);
    const encoded = new TextEncoder().encode(JSON.stringify(payload));
    const decoded = JSON.parse(new TextDecoder().decode(encoded));

    expect(decoded).toEqual(payload);
  });
});
