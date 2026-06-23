import { describe, it, expect } from 'vitest';
import nacl from 'tweetnacl';
import { helpEventId, verifyHelpEventSignature } from '../p2p.js';

describe('ANN help event signatures', () => {
  it('verifies a signed help request event', () => {
    const keypair = nacl.sign.keyPair();
    const author_pubkey = Buffer.from(keypair.publicKey).toString('hex');
    const timestamp = Date.now();
    const request_id = 'request-123';
    const id = helpEventId({ author_pubkey, timestamp, kind: 2, request_id });
    const sig = Buffer.from(
      nacl.sign.detached(Buffer.from(id, 'hex'), keypair.secretKey)
    ).toString('hex');

    expect(verifyHelpEventSignature({
      id,
      sig,
      kind: 2,
      author_pubkey,
      timestamp,
      request_id
    }, 2)).toBe(true);
  });

  it('rejects a help answer with the wrong kind', () => {
    expect(verifyHelpEventSignature({
      id: 'bad',
      sig: 'bad',
      kind: 2,
      author_pubkey: 'bad',
      timestamp: Date.now(),
      request_id: 'request-123',
      answer_id: 'answer-123'
    }, 3)).toBe(false);
  });
});
