/**
 * The MCP server in a worker, with Nirnam: join the bus over the adopted
 * port, serve the same server over a NirnamMCPTransport on it, and say so.
 */

import { connectWorkerBus } from '@palinc/nirnam/worker';
import { NirnamMCPTransport } from '@palinc/nirnam/mcp';
import { createBenchServer } from './server';

connectWorkerBus().then(async bus => {
  await createBenchServer().connect(new NirnamMCPTransport({ agentId: 'bench-server', bus }));
  bus.handle('bench:mcp:ready', () => true);
});
