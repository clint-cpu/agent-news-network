import fs from 'fs';
import path from 'path';
import os from 'os';
import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } from '@libp2p/crypto/keys';
import type { PrivateKey } from '@libp2p/interface';

const PEER_KEY_FILE = 'libp2p-peer-key.bin';

function getIdentityDir(): string {
  return process.env.ANN_IDENTITY_DIR || path.join(os.homedir(), '.ann');
}

export function getPeerPrivateKeyPath(): string {
  return path.join(getIdentityDir(), PEER_KEY_FILE);
}

export async function loadOrGeneratePeerPrivateKey(): Promise<PrivateKey> {
  const annDir = getIdentityDir();
  const keyFile = getPeerPrivateKeyPath();

  if (!fs.existsSync(annDir)) {
    fs.mkdirSync(annDir, { recursive: true });
  }

  if (fs.existsSync(keyFile)) {
    const keyBytes = fs.readFileSync(keyFile);
    return privateKeyFromProtobuf(keyBytes);
  }

  const privateKey = await generateKeyPair('Ed25519');
  fs.writeFileSync(keyFile, Buffer.from(privateKeyToProtobuf(privateKey)));
  fs.chmodSync(keyFile, 0o600);
  console.error(`Generated new libp2p peer identity at ${keyFile}`);

  return privateKey;
}
