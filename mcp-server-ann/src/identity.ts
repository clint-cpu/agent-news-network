import fs from 'fs';
import path from 'path';
import os from 'os';
import nacl from 'tweetnacl';

export interface Identity {
  publicKey: string;
  privateKey: string;
}

export function loadOrGenerateIdentity(): Identity {
  const annDir = process.env.ANN_IDENTITY_DIR || path.join(os.homedir(), '.ann');
  const identityFile = path.join(annDir, 'identity.json');

  if (!fs.existsSync(annDir)) {
    fs.mkdirSync(annDir, { recursive: true });
  }

  if (fs.existsSync(identityFile)) {
    const data = fs.readFileSync(identityFile, 'utf8');
    return JSON.parse(data);
  }

  // Generate new Ed25519 keypair
  const keypair = nacl.sign.keyPair();
  const identity: Identity = {
    publicKey: Buffer.from(keypair.publicKey).toString('hex'),
    privateKey: Buffer.from(keypair.secretKey).toString('hex'),
  };

  fs.writeFileSync(identityFile, JSON.stringify(identity, null, 2), 'utf8');
  // Protect private key with strict filesystem permissions (owner read/write only)
  fs.chmodSync(identityFile, 0o600);
  console.error(`Generated new ANP identity at ${identityFile}`);
  return identity;
}
