import { afterEach, describe, expect, it } from 'vitest';
import { OFFICIAL_ANN_BOOTSTRAP_NODES, PUBLIC_LIBP2P_BOOTSTRAP_NODES, resolveBootstrapNodes } from '../bootstrap-nodes.js';

const previousBootstrapNodes = process.env.ANN_BOOTSTRAP_NODES;
const previousReplaceDefaults = process.env.ANN_BOOTSTRAP_REPLACE_DEFAULTS;

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
});
