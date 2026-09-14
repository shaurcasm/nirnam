/**
 * With Nirnam, server on the main thread: `NirnamMCPTransport` on both ends
 * of one bus — the shape of an MFE that exposes tools to an agent in
 * another MFE. Every JSON-RPC message crosses the hub, so this arm pays the
 * two-hop price and the tool still runs on main. It is here to separate
 * the transport's cost from the thread's.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createBus } from '@palinc/nirnam';
import type { NirnamBus } from '@palinc/nirnam';
import { NirnamMCPTransport } from '@palinc/nirnam/mcp';
import { createBenchServer } from '../server';
import type { McpArm } from '../arm';

export function nirnamMainArm(): McpArm {
  let bus: NirnamBus | null = null;
  let server: McpServer | null = null;
  let client: Client | null = null;
  return {
    id: 'nirnam-main',
    label: 'Nirnam transport · server on main',
    note: 'NirnamMCPTransport both ends · two hops per message · tool runs on main',
    serverThread: 'main',
    async setup() {
      bus = createBus();
      server = createBenchServer();
      await server.connect(new NirnamMCPTransport({ agentId: 'bench-server', bus }));
      client = new Client({ name: 'bench-client', version: '1.0.0' });
      await client.connect(new NirnamMCPTransport({ agentId: 'bench-client', targetAgentId: 'bench-server', bus }));
      return client;
    },
    async teardown() {
      await client?.close();
      await server?.close();
      bus?.close();
      client = server = bus = null;
    },
  };
}
