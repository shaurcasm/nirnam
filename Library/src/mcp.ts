/**
 * NirnamMCPTransport -- implements the Model Context Protocol Transport interface
 * on top of the Nirnam bus.
 *
 * Each transport represents one directed connection: agentId <-> targetAgentId.
 * Messages are enveloped with a `from` field so the recipient knows the sender.
 *
 * Usage:
 *   // Server side (tool provider)
 *   const transport = new NirnamMCPTransport({ agentId: 'calc-agent', bus });
 *   await server.connect(transport);
 *
 *   // Client side (orchestrator)
 *   const transport = new NirnamMCPTransport({ agentId: 'orchestrator', targetAgentId: 'calc-agent', bus });
 *   await client.connect(transport);
 *
 * Import path: @palinc/nirnam/mcp
 * The MCP SDK (@modelcontextprotocol/sdk) is an optional peer dependency --
 * Nirnam defines compatible interfaces so no hard dependency is needed.
 */

import type { NirnamBus } from './bus';
import type { UnsubscribeFn } from './types';

// Minimal JSON-RPC 2.0 message type, structurally compatible with the MCP SDK.
export interface JSONRPCMessage {
  jsonrpc: '2.0';
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Internal envelope wrapping a JSON-RPC message with sender metadata. */
interface MCPEnvelope {
  from: string;
  message: JSONRPCMessage;
}

export interface NirnamMCPTransportOptions {
  /** This agent's ID -- messages arrive on topic `mcp:<agentId>`. */
  agentId: string;
  /**
   * Target agent's ID -- messages are sent to topic `mcp:<targetAgentId>`.
   * Required for clients; optional for servers (falls back to sender of last received message).
   */
  targetAgentId?: string;
  /** The Nirnam bus instance to use. */
  bus: NirnamBus;
}

/**
 * MCP-compatible Transport backed by the Nirnam SharedWorker bus.
 * Structurally satisfies the Transport interface from @modelcontextprotocol/sdk.
 */
export class NirnamMCPTransport {
  onmessage?: (message: JSONRPCMessage) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;

  private readonly agentId: string;
  private readonly targetAgentId?: string;
  private readonly bus: NirnamBus;
  private unsubscribe?: UnsubscribeFn;
  /** Last sender seen -- used as reply target when targetAgentId is not set (server mode). */
  private currentSender: string | null = null;

  constructor(options: NirnamMCPTransportOptions) {
    this.agentId = options.agentId;
    this.targetAgentId = options.targetAgentId;
    this.bus = options.bus;
  }

  async start(): Promise<void> {
    this.unsubscribe = this.bus.subscribe<MCPEnvelope>(
      `mcp:${this.agentId}`,
      (envelope) => {
        this.currentSender = envelope.from;
        try {
          this.onmessage?.(envelope.message);
        } catch (err) {
          this.onerror?.(err as Error);
        }
      },
    );
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const target = this.targetAgentId ?? this.currentSender;
    if (!target) {
      const err = new Error(
        '[NirnamMCPTransport] Cannot send: no targetAgentId and no message has been received yet.'
      );
      this.onerror?.(err);
      throw err;
    }
    this.bus.publish<MCPEnvelope>(`mcp:${target}`, { from: this.agentId, message });
  }

  async close(): Promise<void> {
    this.unsubscribe?.();
    this.onclose?.();
  }
}

