/**
 * An MCP arm connects a Client to the bench server somewhere and hands the
 * workloads the connected client. Where the server runs is in the note.
 */

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

export interface McpArm {
  id: string;
  label: string;
  note: string;
  /** Where the tool's own work lands. */
  serverThread: 'main' | 'worker';
  setup(): Promise<Client>;
  teardown(): Promise<void>;
}
