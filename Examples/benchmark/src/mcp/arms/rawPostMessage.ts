/**
 * Without Nirnam, server in a worker: an MCP Transport hand-rolled over
 * `worker.postMessage` on this side and `self.postMessage` on the other
 * (raw-mcp.worker.ts). One worker, one server, one client — the simplest
 * case, and already two transport classes to own. A second server, or a
 * server in another MFE's worker, or a client in an iframe, is more of the
 * same. Same traffic pattern as the Nirnam worker arm, so the numbers
 * should be close; the effort panel counts what differs.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { McpArm } from '../arm';

class PageSideTransport implements Transport {
  onmessage?: (message: JSONRPCMessage) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;
  private listener = (event: MessageEvent) => {
    if (event.data?.kind === 'mcp') this.onmessage?.(event.data.message as JSONRPCMessage);
  };
  constructor(private worker: Worker) {}
  async start() {
    this.worker.addEventListener('message', this.listener);
  }
  async send(message: JSONRPCMessage) {
    this.worker.postMessage({ kind: 'mcp', message });
  }
  async close() {
    this.worker.removeEventListener('message', this.listener);
    this.onclose?.();
  }
}

function untilReady(worker: Worker): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('MCP worker never became ready')), 10000);
    const onMessage = (event: MessageEvent) => {
      if (event.data?.kind !== 'ready') return;
      clearTimeout(timer);
      worker.removeEventListener('message', onMessage);
      resolve();
    };
    worker.addEventListener('message', onMessage);
  });
}

export function rawPostMessageArm(): McpArm {
  let worker: Worker | null = null;
  let client: Client | null = null;
  return {
    id: 'raw-postmessage',
    label: 'Raw postMessage transport · server in a worker',
    note: 'no Nirnam · two Transport classes hand-rolled · tool runs in the worker',
    serverThread: 'worker',
    async setup() {
      worker = new Worker(new URL('../raw-mcp.worker.ts', import.meta.url), { type: 'module' });
      await untilReady(worker);
      client = new Client({ name: 'bench-client', version: '1.0.0' });
      await client.connect(new PageSideTransport(worker));
      return client;
    },
    async teardown() {
      await client?.close();
      worker?.terminate();
      client = worker = null;
    },
  };
}
