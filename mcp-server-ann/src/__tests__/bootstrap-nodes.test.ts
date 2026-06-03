import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import nacl from 'tweetnacl';
import { OFFICIAL_ANN_BOOTSTRAP_NODES, PUBLIC_LIBP2P_BOOTSTRAP_NODES, resolveBootstrapNodes } from '../bootstrap-nodes.js';
import { buildBootstrapAnnouncement, saveBootstrapCache } from '../bootstrap-registry.js';

const previousBootstrapNodes = process.env.ANN_BOOTSTRAP_NODES;
const previousReplaceDefaults = process.env.ANN_BOOTSTRAP_REPLACE_DEFAULTS;
const previousIdentityDir = process.env.ANN_IDENTITY_DIR;
let tempDir: string;

function createIdentity() {
  const kp = nacl.sign.keyPair();
  return {
    publicKey: Buffer.from(kp.publicKey).toString('hex'),
    privateKey: Buffer.from(kp.secretKey).toString('hex')
  };
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ann-bootstrap-nodes-'));
  process.env.ANN_IDENTITY_DIR = tempDir;
});

afterEach(() => {
  if (previousBootstrapNodes === undefined) {
    delete process.env.ANN_BOOTSTRAP_NODES;
  } else {
    process.env.ANN_BOOTSTRAP_NODES = previousBootstrapNodes;
  }

  if (previousReplaceDefaults === undefined) {
    delete process.env.ANN_BOOTSTRAP_REPLACE_DEFAULTS;
  } else {
    process.env.ANN_BOOTSTRAP_REPLACE_DEFAULTS = previousReplaceDefaults;
  }

  if (previousIdentityDir === undefined) {
    delete process.env.ANN_IDENTITY_DIR;
  } else {
    process.env.ANN_IDENTITY_DIR = previousIdentityDir;
  }

  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('bootstrap node resolution', () => {
  it('uses the official ANN bootstrap node by default', () => {
    delete process.env.ANN_BOOTSTRAP_NODES;
    delete process.env.ANN_BOOTSTRAP_REPLACE_DEFAULTS;

    const nodes = resolveBootstrapNodes();

    expect(nodes).toContain(OFFICIAL_ANN_BOOTSTRAP_NODES[0]);
    expect(nodes).toContain(PUBLIC_LIBP2P_BOOTSTRAP_NODES[0]);
  });

  it('prepends configured nodes while keeping built-in defaults', () => {
    process.env.ANN_BOOTSTRAP_NODES = '/ip4/203.0.113.10/tcp/41230/ws/p2p/12D3KooWVolunteer';
    delete process.env.ANN_BOOTSTRAP_REPLACE_DEFAULTS;

    const nodes = resolveBootstrapNodes();

    expect(nodes[0]).toBe('/ip4/203.0.113.10/tcp/41230/ws/p2p/12D3KooWVolunteer');
    expect(nodes).toContain(OFFICIAL_ANN_BOOTSTRAP_NODES[0]);
  });

  it('allows private deployments to replace built-in defaults', () => {
    process.env.ANN_BOOTSTRAP_NODES = '/ip4/203.0.113.11/tcp/41230/ws/p2p/12D3KooWPrivate';
    process.env.ANN_BOOTSTRAP_REPLACE_DEFAULTS = 'true';

    expect(resolveBootstrapNodes()).toEqual(['/ip4/203.0.113.11/tcp/41230/ws/p2p/12D3KooWPrivate']);
  });

  it('includes verified cached bootstrap nodes in default resolution', () => {
    const cachedAddr = '/ip4/203.0.113.12/tcp/41230/ws/p2p/12D3KooWCached';
    const announcement = buildBootstrapAnnouncement({
      peerId: '12D3KooWCached',
      multiaddrs: [cachedAddr],
      identity: createIdentity()
    });
    saveBootstrapCache([announcement]);

    expect(resolveBootstrapNodes()).toContain(cachedAddr);
  });
});
