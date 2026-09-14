/**
 * With Nirnam, server in a worker: the page adopts the worker into the bus,
 * the worker builds the same server over `NirnamMCPTransport` on its own
 * worker bus (mcp.worker.ts), and the client on main is the same client as
 * the main-thread arm — it does not know the server moved. The tool's work
 * now lands on the worker; the main thread pays for the JSON-RPC envelope
 * and nothing else.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createBus } from '@palinc/nirnam';
import type { NirnamBus } from '@palinc/nirnam';
import { NirnamMCPTransport } from '@palinc/nirnam/mcp';
import type { McpArm } from '../arm';

async function untilServing(bus: NirnamBus): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      await bus.request('bench:mcp:ready', null, 1000);
      return;
    } catch {
      await new Promise(r => setTimeout(r, 25));
    }
  }
  throw new Error('MCP worker never joined the bus');
}

export function nirnamWorkerArm(): McpArm {
  let bus: NirnamBus | null = null;
  let worker: Worker | null = null;
  let adoption: { release(): void } | null = null;
  let client: Client | null = null;
  return {
    id: 'nirnam-worker',
    label: 'Nirnam transport · server in a worker',
    note: 'adoptWorker + connectWorkerBus · same client · tool runs in the worker',
    serverThread: 'worker',
    async setup() {
      bus = createBus();
      worker = new Worker(new URL('../mcp.worker.ts', import.meta.url), { type: 'module' });
      adoption = bus.adoptWorker(worker);
      await untilServing(bus);
      client = new Client({ name: 'bench-client', version: '1.0.0' });
      await client.connect(new NirnamMCPTransport({ agentId: 'bench-client', targetAgentId: 'bench-server', bus }));
      return client;
    },
    async teardown() {
      await client?.close();
      adoption?.release();
      worker?.terminate();
      bus?.close();
      client = adoption = worker = bus = null;
    },
  };
}
