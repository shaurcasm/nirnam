/**
 * The one MCP server every arm serves — on the main thread or in a worker.
 * Two tools: `echo`, which costs nothing, and `analyse`, which holds the
 * thread it runs on for `ms` milliseconds of real work. Where that thread
 * is, is the whole point of the MCP tab.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { spin } from '../harness/runner';

export function createBenchServer(): McpServer {
  const server = new McpServer({ name: 'bench-server', version: '1.0.0' });
  server.registerTool('echo', { inputSchema: { seq: z.number() } }, async ({ seq }) => ({
    content: [{ type: 'text', text: String(seq) }],
  }));
  server.registerTool('analyse', { inputSchema: { seq: z.number(), ms: z.number() } }, async ({ seq, ms }) => {
    const x = spin(ms);
    return { content: [{ type: 'text', text: `${seq}:${x}` }] };
  });
  return server;
}
