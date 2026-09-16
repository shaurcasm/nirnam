/**
 * The MCP server in a worker, without Nirnam: a Transport hand-rolled over
 * the worker's own postMessage. The mirror image lives in arms/rawPostMessage.ts.
 */

import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { createBenchServer } from './server';

const scope = self as unknown as {
  postMessage(m: unknown): void;
  addEventListener(t: 'message', l: (e: MessageEvent) => void): void;
  removeEventListener(t: 'message', l: (e: MessageEvent) => void): void;
};

class WorkerSideTransport implements Transport {
  onmessage?: (message: JSONRPCMessage) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;
  private listener = (event: MessageEvent) => {
    if (event.data?.kind === 'mcp') this.onmessage?.(event.data.message as JSONRPCMessage);
  };
  async start() {
    scope.addEventListener('message', this.listener);
  }
  async send(message: JSONRPCMessage) {
    scope.postMessage({ kind: 'mcp', message });
  }
  async close() {
    scope.removeEventListener('message', this.listener);
    this.onclose?.();
  }
}

createBenchServer()
  .connect(new WorkerSideTransport())
  .then(() => scope.postMessage({ kind: 'ready' }));
