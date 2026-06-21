import workerSource from './worker-source';
import {
  NirnamErrorCode,
  NirnamRequestError,
  RequestType,
} from './types';
import type {
  NirnamBusOptions,
  NirnamMessage,
  SubscribeHandler,
  RequestHandler,
  StreamHandler,
  AgentRegistration,
  AgentChangeHandler,
  UnsubscribeFn,
} from './types';
import { DataEvent } from './data-event';

const PAGE_ID = Math.random().toString(36).slice(2);
const CHANNEL_NAME = 'nirnam-bus-v1';
const WORKER_NAME = 'nirnam-message-worker';

const STREAM_END_SENTINEL = Symbol('nirnam.stream.end');

let workerBlobUrl: string | null = null;

function resolveWorkerUrl(staticUrl?: string): string {
  if (staticUrl) return staticUrl;
  if (!workerBlobUrl) {
    const blob = new Blob([workerSource], { type: 'application/javascript' });
    workerBlobUrl = URL.createObjectURL(blob);
  }
  return workerBlobUrl;
}

interface StreamPending {
  push(chunk: unknown): void;
  end(): void;
  abort(err: Error): void;
}

/**
 * Three-layer hybrid message bus:
 *
 * Layer 1 - BroadcastChannel: cross-tab pub/sub fan-out, zero deployment.
 * Layer 2 - Blob URL SharedWorker: within-page subscriber registry, routing,
 *            request-reply, streaming, and agent registration.
 * Layer 3 - Static URL SharedWorker (opt-in via workerUrl): true cross-tab
 *            SharedWorker sharing when a static file can be served.
 */
export class NirnamBus {
  private readonly worker: SharedWorker;
  private readonly channel: BroadcastChannel | null;
  private readonly handlers = new Map<string, Set<SubscribeHandler>>();
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private readonly streamHandlers = new Map<string, StreamHandler>();
  private readonly pending = new Map<string, {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private readonly pendingStreams = new Map<string, StreamPending>();
  private readonly pendingDiscoveries = new Map<string, (agents: AgentRegistration[]) => void>();
  private readonly subscribedTopics = new Set<string>();
  private readonly agentChangeHandlers = new Set<AgentChangeHandler>();
  private isWatchingAgents = false;
  private readonly timeout: number;
  private readonly dispatchDOMEvents: boolean;

  constructor(options: NirnamBusOptions = {}) {
    const { workerUrl, useBroadcastChannel = true, requestTimeout = 5000, dispatchDOMEvents = false } = options;
    this.dispatchDOMEvents = dispatchDOMEvents;

    this.timeout = requestTimeout;

    this.worker = new SharedWorker(resolveWorkerUrl(workerUrl), { name: WORKER_NAME });
    this.worker.port.onmessage = (e) => this._handleWorkerMessage(e);
    this.worker.onerror = (e) => console.error('[Nirnam]', e);
    this.worker.port.start();

    this.channel =
      useBroadcastChannel && typeof BroadcastChannel !== 'undefined'
        ? new BroadcastChannel(CHANNEL_NAME)
        : null;

    if (this.channel) {
      this.channel.onmessage = (e) => this._handleChannelMessage(e);
    }
  }

  // ---- Pub/Sub (BROAD) -------------------------------------------------------

  subscribe<T>(topic: string, handler: SubscribeHandler<T>): UnsubscribeFn {
    this._ensureSubscribed(topic);
    if (!this.handlers.has(topic)) this.handlers.set(topic, new Set());
    this.handlers.get(topic)!.add(handler as SubscribeHandler);
    return () => this._removeHandler(topic, handler as SubscribeHandler);
  }

  publish<T>(topic: string, payload: T): void {
    this.worker.port.postMessage({ type: 'broadcast', topic, payload, sourcePageId: PAGE_ID });
    this.channel?.postMessage({ type: 'broadcast', topic, payload, sourcePageId: PAGE_ID });
    if (this.dispatchDOMEvents && typeof window !== 'undefined') {
      window.dispatchEvent(new DataEvent<T>(RequestType.BROAD, topic, payload));
    }
  }

  // ---- Request-Reply (NARROW) ------------------------------------------------

  handle<Req, Res>(topic: string, handler: RequestHandler<Req, Res>): UnsubscribeFn {
    this._ensureSubscribed(topic);
    this.requestHandlers.set(topic, handler as RequestHandler);
    return () => {
      this.requestHandlers.delete(topic);
      this._checkUnsubscribe(topic);
    };
  }

  request<Req, Res>(topic: string, payload: Req, timeout?: number): Promise<Res> {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const ms = timeout ?? this.timeout;

    return new Promise<Res>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new NirnamRequestError(
          NirnamErrorCode.TIMEOUT,
          `[Nirnam] Request on "${topic}" timed out after ${ms}ms`,
        ));
      }, ms);
      this.pending.set(requestId, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.worker.port.postMessage({ type: 'request', topic, payload, requestId });
    });
  }

  // ---- Streaming (NARROW streaming) ------------------------------------------

  handleStream<Req, Res>(topic: string, handler: StreamHandler<Req, Res>): UnsubscribeFn {
    this._ensureSubscribed(topic);
    this.streamHandlers.set(topic, handler as StreamHandler);
    return () => {
      this.streamHandlers.delete(topic);
      this._checkUnsubscribe(topic);
    };
  }

  requestStream<Req, Res>(topic: string, payload: Req): AsyncIterable<Res> {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const queue: unknown[] = [];
    let notify: (() => void) | null = null;
    let streamError: Error | null = null;

    this.pendingStreams.set(requestId, {
      push: (chunk: unknown) => {
        queue.push(chunk);
        const fn = notify; notify = null; fn?.();
      },
      end: () => {
        queue.push(STREAM_END_SENTINEL);
        const fn = notify; notify = null; fn?.();
      },
      abort: (err: Error) => {
        streamError = err;
        const fn = notify; notify = null; fn?.();
      },
    });

    this.worker.port.postMessage({ type: 'request-stream', topic, payload, requestId });

    return {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<Res>> => {
          while (queue.length === 0 && !streamError) {
            await new Promise<void>(r => { notify = r; });
          }
          if (streamError) throw streamError;
          const item = queue.shift();
          if (item === STREAM_END_SENTINEL) return { value: undefined as unknown as Res, done: true };
          return { value: item as Res, done: false };
        },
      }),
    };
  }

  // ---- Agent Registration Protocol -------------------------------------------

  /**
   * Register this bus as an agent with the given capabilities.
   * The registration is scoped to the SharedWorker process (within-page).
   */
  register(registration: AgentRegistration): void {
    this.worker.port.postMessage({
      type: 'register',
      agentId: registration.agentId,
      capabilities: registration.capabilities,
      metadata: registration.metadata,
    });
  }

  /**
   * Discover all currently registered agents in the SharedWorker.
   * Returns a snapshot; subscribe to onAgentChange for live updates.
   */
  discoverAgents(): Promise<AgentRegistration[]> {
    const requestId = `discover-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return new Promise<AgentRegistration[]>((resolve) => {
      this.pendingDiscoveries.set(requestId, resolve);
      this.worker.port.postMessage({ type: 'discover', requestId });
    });
  }

  /**
   * Subscribe to agent join/leave events.
   * The first call sends a watch-agents message to the worker.
   * Returns an unsubscribe function.
   */
  onAgentChange(handler: AgentChangeHandler): UnsubscribeFn {
    if (!this.isWatchingAgents) {
      this.isWatchingAgents = true;
      this.worker.port.postMessage({ type: 'watch-agents' });
    }
    this.agentChangeHandlers.add(handler);
    return () => this.agentChangeHandlers.delete(handler);
  }

  // ---- Lifecycle -------------------------------------------------------------

  close(): void {
    this.worker.port.close();
    this.channel?.close();
  }

  // ---- Private ---------------------------------------------------------------

  private _ensureSubscribed(topic: string): void {
    if (!this.subscribedTopics.has(topic)) {
      this.subscribedTopics.add(topic);
      this.worker.port.postMessage({ type: 'subscribe', topic });
    }
  }

  private _removeHandler(topic: string, handler: SubscribeHandler): void {
    const set = this.handlers.get(topic);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) this.handlers.delete(topic);
    this._checkUnsubscribe(topic);
  }

  private _checkUnsubscribe(topic: string): void {
    const hasHandlers = (this.handlers.get(topic)?.size ?? 0) > 0;
    const hasRequestHandler = this.requestHandlers.has(topic);
    const hasStreamHandler = this.streamHandlers.has(topic);
    if (!hasHandlers && !hasRequestHandler && !hasStreamHandler && this.subscribedTopics.has(topic)) {
      this.subscribedTopics.delete(topic);
      this.worker.port.postMessage({ type: 'unsubscribe', topic });
    }
  }

  private _handleWorkerMessage(event: MessageEvent<NirnamMessage>): void {
    const { type, topic, payload, requestId, error, code } = event.data;

    switch (type) {
      case 'broadcast':
        if (topic) this.handlers.get(topic)?.forEach(h => h(payload));
        break;

      case 'request':
        if (topic && requestId) {
          const handler = this.requestHandlers.get(topic);
          if (handler) {
            Promise.resolve()
              .then(() => handler(payload))
              .then(result => {
                this.worker.port.postMessage({ type: 'response', requestId, payload: result });
              })
              .catch(err => {
                this.worker.port.postMessage({
                  type: 'error',
                  requestId,
                  error: String((err as Error).message ?? err),
                  code: NirnamErrorCode.HANDLER_REJECTED,
                });
              });
          }
        }
        break;

      case 'request-stream':
        if (topic && requestId) {
          const handler = this.streamHandlers.get(topic);
          if (handler) {
            (async () => {
              try {
                for await (const chunk of handler(payload)) {
                  this.worker.port.postMessage({ type: 'stream-chunk', requestId, payload: chunk });
                }
                this.worker.port.postMessage({ type: 'stream-end', requestId });
              } catch (err) {
                this.worker.port.postMessage({
                  type: 'error',
                  requestId,
                  error: String((err as Error).message ?? err),
                  code: NirnamErrorCode.HANDLER_REJECTED,
                });
              }
            })();
          } else {
            this.worker.port.postMessage({
              type: 'error',
              requestId,
              error: `No stream handler registered for topic "${topic}"`,
              code: NirnamErrorCode.NO_HANDLER,
            });
          }
        }
        break;

      case 'stream-chunk':
        if (requestId) this.pendingStreams.get(requestId)?.push(payload);
        break;

      case 'stream-end':
        if (requestId) {
          const stream = this.pendingStreams.get(requestId);
          if (stream) { stream.end(); this.pendingStreams.delete(requestId); }
        }
        break;

      case 'response':
        if (requestId) {
          const p = this.pending.get(requestId);
          if (p) { clearTimeout(p.timer); this.pending.delete(requestId); p.resolve(payload); }
        }
        break;

      case 'error':
        if (requestId) {
          const p = this.pending.get(requestId);
          if (p) {
            clearTimeout(p.timer);
            this.pending.delete(requestId);
            p.reject(new NirnamRequestError(
              /* istanbul ignore next */ (code as NirnamErrorCode) ?? NirnamErrorCode.HANDLER_REJECTED,
              /* istanbul ignore next */ `[Nirnam] ${error ?? 'Unknown error'}`,
            ));
          }
          const stream = this.pendingStreams.get(requestId);
          if (stream) {
            stream.abort(new NirnamRequestError(
              /* istanbul ignore next */ (code as NirnamErrorCode) ?? NirnamErrorCode.HANDLER_REJECTED,
              /* istanbul ignore next */ `[Nirnam] ${error ?? 'Unknown error'}`,
            ));
            this.pendingStreams.delete(requestId);
          }
        }
        break;

      case 'agent-list':
        if (requestId) {
          const resolve = this.pendingDiscoveries.get(requestId);
          if (resolve) {
            this.pendingDiscoveries.delete(requestId);
            resolve((event.data.agents as AgentRegistration[]) ?? []);
          }
        }
        break;

      case 'agent-joined': {
        const agent = event.data.agent as AgentRegistration;
        this.agentChangeHandlers.forEach(h => h({ type: 'join', agent }));
        break;
      }

      case 'agent-left': {
        const agentId = event.data.agentId as string;
        this.agentChangeHandlers.forEach(h => h({ type: 'leave', agentId }));
        break;
      }
    }
  }

  private _handleChannelMessage(event: MessageEvent<NirnamMessage>): void {
    const { type, topic, payload, sourcePageId } = event.data;
    if (sourcePageId === PAGE_ID) return;
    if (type === 'broadcast' && topic) {
      this.handlers.get(topic)?.forEach(h => h(payload));
    }
  }
}

export function createBus(options?: NirnamBusOptions): NirnamBus {
  return new NirnamBus(options);
}
