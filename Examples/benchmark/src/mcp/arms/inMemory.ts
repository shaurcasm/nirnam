/**
 * Without Nirnam, main thread only: the SDK's own `InMemoryTransport`
 * pair — server and client in the same module, no bus. The lowest-overhead
 * MCP there is, and the tool runs on the main thread, because there is
 * nowhere else for it to run.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createBenchServer } from '../server';
import type { McpArm } from '../arm';

export function inMemoryArm(): McpArm {
  let server: McpServer | null = null;
  let client: Client | null = null;
  return {
    id: 'in-memory',
    label: 'SDK InMemoryTransport',
    note: 'no Nirnam · server and client in one module · tool runs on main',
    serverThread: 'main',
    async setup() {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      server = createBenchServer();
      await server.connect(serverTransport);
      client = new Client({ name: 'bench-client', version: '1.0.0' });
      await client.connect(clientTransport);
      return client;
    },
    async teardown() {
      await client?.close();
      await server?.close();
      client = server = null;
    },
  };
}
