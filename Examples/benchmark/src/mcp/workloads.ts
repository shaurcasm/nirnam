/**
 * The MCP workloads: `callTool` round trips, cheap and heavy, sequential
 * and concurrent. The heavy tool holds its thread for `toolMs`; whether
 * that thread is the main one is what the lag and fps columns show.
 */

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Metrics } from '../harness/stats';
import { summarise } from '../harness/stats';

export interface McpParams {
  calls: number;
  heavyCalls: number;
  toolMs: number;
  concurrency: number;
}

export const DEFAULT_MCP_PARAMS: McpParams = { calls: 300, heavyCalls: 40, toolMs: 8, concurrency: 8 };

export interface McpWorkload {
  id: string;
  label: string;
  describe(params: McpParams): string;
  run(client: Client, params: McpParams): Promise<Metrics>;
}

async function sequential(client: Client, name: string, count: number, args: (i: number) => Record<string, unknown>): Promise<Metrics> {
  const latencies: number[] = [];
  const start = performance.now();
  for (let i = 0; i < count; i++) {
    const before = performance.now();
    await client.callTool({ name, arguments: args(i) });
    latencies.push(performance.now() - before);
  }
  const wall = performance.now() - start;
  const lat = summarise(latencies);
  return { wall, throughput: count / (wall / 1000), 'lat.p50': lat.p50, 'lat.p95': lat.p95, 'lat.max': lat.max };
}

const echo: McpWorkload = {
  id: 'echo',
  label: 'echo',
  describe: p => `${p.calls} sequential calls of a tool that does nothing`,
  run: (client, { calls }) => sequential(client, 'echo', calls, seq => ({ seq })),
};

const analyse: McpWorkload = {
  id: 'analyse',
  label: 'analyse',
  describe: p => `${p.heavyCalls} sequential calls of a tool that works for ${p.toolMs} ms`,
  run: (client, { heavyCalls, toolMs }) => sequential(client, 'analyse', heavyCalls, seq => ({ seq, ms: toolMs })),
};

const analyseConcurrent: McpWorkload = {
  id: 'analyse-concurrent',
  label: 'analyse ×N',
  describe: p => `${p.heavyCalls} calls of the ${p.toolMs} ms tool, ${p.concurrency} in flight`,
  async run(client, { heavyCalls, toolMs, concurrency }) {
    const latencies: number[] = [];
    let next = 0;
    const start = performance.now();
    const lane = async () => {
      while (next < heavyCalls) {
        const seq = next++;
        const before = performance.now();
        await client.callTool({ name: 'analyse', arguments: { seq, ms: toolMs } });
        latencies.push(performance.now() - before);
      }
    };
    await Promise.all(Array.from({ length: concurrency }, lane));
    const wall = performance.now() - start;
    const lat = summarise(latencies);
    return { wall, throughput: heavyCalls / (wall / 1000), 'lat.p50': lat.p50, 'lat.p95': lat.p95, 'lat.max': lat.max };
  },
};

export const MCP_WORKLOADS: McpWorkload[] = [echo, analyse, analyseConcurrent];
