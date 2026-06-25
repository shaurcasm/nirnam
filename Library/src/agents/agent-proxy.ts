import type { NirnamBus } from '../bus';

export interface AgentProxyOptions {
  /** Default request timeout in ms. Applies to chat() and run(). Default: 30 000. */
  timeout?: number;
}

/** Payload types shared between AgentProxy and the page-scope handler registration. */
export interface PageChatRequest { message: string; maxIterations?: number }
export interface PageRunRequest { task: string; maxIterations?: number }

/**
 * Lightweight cross-tab proxy for a `scope: 'page'` agent running in another tab.
 *
 * All method calls are forwarded over the Nirnam bus to the host tab that owns the
 * real NirnamAgent instance.  Requires a Layer 3 (static URL SharedWorker) bus so
 * that request routing works across browser tabs.
 *
 * @example
 * const proxy = createAgentProxy('my-agent', bus);
 * const reply = await proxy.chat('Hello!');
 */
export class AgentProxy {
  readonly agentId: string;
  private readonly _bus: NirnamBus;
  private readonly _timeout: number;

  constructor(agentId: string, bus: NirnamBus, options?: AgentProxyOptions) {
    this.agentId = agentId;
    this._bus = bus;
    this._timeout = options?.timeout ?? 30_000;
  }

  /**
   * Forward a chat message to the host-tab agent and return the full response.
   */
  chat(message: string, options?: { maxIterations?: number; timeout?: number }): Promise<string> {
    return this._bus.request<PageChatRequest, string>(
      `${this.agentId}:__chat`,
      { message, maxIterations: options?.maxIterations },
      options?.timeout ?? this._timeout,
    );
  }

  /**
   * Forward a run task to the host-tab agent.  History is not retained (same as
   * calling agent.run() directly with the default retainHistory: false).
   */
  run(task: string, options?: { maxIterations?: number; timeout?: number }): Promise<string> {
    return this._bus.request<PageRunRequest, string>(
      `${this.agentId}:__run`,
      { task, maxIterations: options?.maxIterations },
      options?.timeout ?? this._timeout,
    );
  }

  /**
   * Stream a chat response token-by-token from the host-tab agent.
   */
  async *chatStream(message: string, options?: { maxIterations?: number }): AsyncGenerator<string> {
    yield* this._bus.requestStream<PageChatRequest, string>(
      `${this.agentId}:__stream`,
      { message, maxIterations: options?.maxIterations },
    );
  }
}

/**
 * Create an `AgentProxy` that forwards calls to a `scope: 'page'` agent running
 * in another tab via the shared bus.
 *
 * The proxy is created immediately without verifying the remote agent exists.
 * If the agent is unreachable the first method call will throw a
 * `NirnamRequestError` with code `NO_HANDLER` or `TIMEOUT`.
 *
 * @param agentId - Must match the `agentId` of the target page-scoped agent.
 * @param bus     - A `NirnamBus` instance connected to the same Layer 3 worker.
 * @param options - Optional timeout override.
 */
export function createAgentProxy(
  agentId: string,
  bus: NirnamBus,
  options?: AgentProxyOptions,
): AgentProxy {
  return new AgentProxy(agentId, bus, options);
}
