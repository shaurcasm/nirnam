import workerSource from './worker-source';
import {
  NirnamErrorCode,
  NirnamRequestError,
  RequestType,
  NIRNAM_CONNECT,
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
  PublishOptions,
  SubscribeOptions,
} from './types';
import type { BusConnectionKind } from './types';
import { DataEvent } from './data-event';
import { persistMessage, replayMessages, DEFAULT_PERSISTENCE_TTL } from './persistence';
import { openHubPort } from './hub-port';
import type { BusPort, HubConnection } from './hub-port';

const PAGE_ID = Math.random().toString(36).slice(2);
const CHANNEL_NAME = 'nirnam-bus-v1';

const STREAM_END_SENTINEL = Symbol('nirnam.stream.end');

let workerBlobUrl: string | null = null;

// Injected at bundle time by @palinc/nirnam/vite, /rsbuild, or /webpack.
// When present, the worker (dedicated or shared) loads from this static URL
// instead of a Blob URL — what a strict `worker-src` CSP needs, and what
// lets a SharedWorker be shared across tabs.
declare const __NIRNAM_STATIC_WORKER_URL__: string | undefined;

function resolveWorkerUrl(staticUrl?: string): string {
  if (staticUrl) return staticUrl;
  if (typeof __NIRNAM_STATIC_WORKER_URL__ === 'string') {
    return __NIRNAM_STATIC_WORKER_URL__;
  }
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
 * The bus: one participant's connection to a routing hub, plus a
 * BroadcastChannel for cross-tab fan-out.
 *
 * The hub — subscriber registry, request-reply routing, streaming, agent
 * registration — runs in a dedicated Worker by default, in a SharedWorker on
 * request, or inline on this thread. The bus does not care which; see
 * `HubKind` for what each one gives up.
 *
 * BroadcastChannel carries `publish()` to every other tab regardless of hub.
 */
export class NirnamBus {
  private readonly connection: HubConnection;
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
  private readonly defaultTtl: number;

  /**
   * @param connection An already-open connection to use instead of choosing a
   *   hub from `options.hub` — how a worker bus is built over a port it was
   *   handed. Such a bus has no BroadcastChannel: the hub is its whole reach.
   */
  constructor(options: NirnamBusOptions = {}, connection?: HubConnection) {
    const { hub, workerUrl, useBroadcastChannel = true, requestTimeout = 5000, dispatchDOMEvents = false, persistence } = options;
    this.dispatchDOMEvents = dispatchDOMEvents;
    this.defaultTtl = persistence?.defaultTtl ?? DEFAULT_PERSISTENCE_TTL;

    this.timeout = requestTimeout;

    this.connection = connection ?? openHubPort(hub, () => resolveWorkerUrl(workerUrl));
    this.port.onmessage = (e) => this._handleWorkerMessage(e);

    this.channel =
      !connection && useBroadcastChannel && typeof BroadcastChannel !== 'undefined'
        ? new BroadcastChannel(CHANNEL_NAME)
        : null;

    if (this.channel) {
      this.channel.onmessage = (e) => this._handleChannelMessage(e);
    }
  }

  /**
   * Which hub this bus actually connected to, after any fallback — or
   * `'port'` for a bus built over a port another bus adopted.
   */
  get hub(): BusConnectionKind {
    return this.connection.kind;
  }

  private get port(): BusPort {
    return this.connection.port;
  }

  // ---- Pub/Sub (BROAD) -------------------------------------------------------

  subscribe<T>(topic: string, handler: SubscribeHandler<T>, options?: SubscribeOptions): UnsubscribeFn {
    this._ensureSubscribed(topic);
    if (!this.handlers.has(topic)) this.handlers.set(topic, new Set());
    this.handlers.get(topic)!.add(handler as SubscribeHandler);
    if (options?.replay && options.replay > 0) {
      replayMessages(topic, options.replay)
        .then(messages => messages.forEach(m => (handler as SubscribeHandler)(m.payload)))
        .catch(() => {});
    }
    return () => this._removeHandler(topic, handler as SubscribeHandler);
  }

  publish<T>(topic: string, payload: T, options?: PublishOptions): void {
    this.port.postMessage({ type: 'broadcast', topic, payload, sourcePageId: PAGE_ID });
    this.channel?.postMessage({ type: 'broadcast', topic, payload, sourcePageId: PAGE_ID });
    if (this.dispatchDOMEvents && typeof window !== 'undefined') {
      window.dispatchEvent(new DataEvent<T>(RequestType.BROAD, topic, payload));
    }
    if (options?.persist) {
      persistMessage(topic, payload, options.ttl ?? this.defaultTtl).catch(() => {});
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
      this.port.postMessage({ type: 'request', topic, payload, requestId });
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

    this.port.postMessage({ type: 'request-stream', topic, payload, requestId });

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
   * The registration is scoped to the hub — this page, or every tab of the
   * origin under a shared hub.
   */
  register(registration: AgentRegistration): void {
    this.port.postMessage({
      type: 'register',
      agentId: registration.agentId,
      capabilities: registration.capabilities,
      metadata: registration.metadata,
    });
  }

  /**
   * Discover all currently registered agents on the hub.
   * Returns a snapshot; subscribe to onAgentChange for live updates.
   */
  discoverAgents(): Promise<AgentRegistration[]> {
    const requestId = `discover-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return new Promise<AgentRegistration[]>((resolve) => {
      this.pendingDiscoveries.set(requestId, resolve);
      this.port.postMessage({ type: 'discover', requestId });
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
      this.port.postMessage({ type: 'watch-agents' });
    }
    this.agentChangeHandlers.add(handler);
    return () => this.agentChangeHandlers.delete(handler);
  }

  // ---- Participants ----------------------------------------------------------

  /**
   * Hand the hub the other end of a channel, making whoever holds it a full
   * participant — a dedicated worker, typically, since a worker can reach the
   * hub only through a port it is given. After this, traffic between that
   * participant and the hub never touches this thread.
   *
   * The port is transferred: do not use it here afterwards.
   */
  adoptPort(port: MessagePort): void {
    this.port.postMessage({ type: 'connect' }, [port]);
  }

  /**
   * Make a dedicated worker of your own a participant: one end of a fresh
   * channel goes to the hub, the other to the worker in a `nirnam:connect`
   * message, which `connectWorkerBus()` from `@palinc/nirnam/worker` awaits.
   */
  adoptWorker(worker: Worker): void {
    const { port1, port2 } = new MessageChannel();
    this.adoptPort(port1);
    worker.postMessage({ type: NIRNAM_CONNECT }, [port2]);
  }

  // ---- Lifecycle -------------------------------------------------------------

  /**
   * Leave the hub and close the channel. Under a dedicated hub the worker
   * terminates once the last bus on the page has closed.
   */
  close(): void {
    this.connection.release();
    this.channel?.close();
  }

  // ---- Private ---------------------------------------------------------------

  private _ensureSubscribed(topic: string): void {
    if (!this.subscribedTopics.has(topic)) {
      this.subscribedTopics.add(topic);
      this.port.postMessage({ type: 'subscribe', topic });
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
      this.port.postMessage({ type: 'unsubscribe', topic });
    }
  }

  private _handleWorkerMessage(event: { data: unknown }): void {
    const message = event.data as NirnamMessage;
    const { type, topic, payload, requestId, error, code } = message;

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
                this.port.postMessage({ type: 'response', requestId, payload: result });
              })
              .catch(err => {
                this.port.postMessage({
                  type: 'error',
                  requestId,
                  error: String((err as Error).message ?? err),
                  code: NirnamErrorCode.HANDLER_REJECTED,
                });
              });
          } else {
            // Subscribed for broadcasts only; the hub cannot tell. Say so
            // rather than leave the requester to time out.
            this.port.postMessage({
              type: 'error',
              requestId,
              error: `No request handler registered for topic "${topic}"`,
              code: NirnamErrorCode.NO_HANDLER,
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
                  this.port.postMessage({ type: 'stream-chunk', requestId, payload: chunk });
                }
                this.port.postMessage({ type: 'stream-end', requestId });
              } catch (err) {
                this.port.postMessage({
                  type: 'error',
                  requestId,
                  error: String((err as Error).message ?? err),
                  code: NirnamErrorCode.HANDLER_REJECTED,
                });
              }
            })();
          } else {
            this.port.postMessage({
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
            resolve((message.agents as AgentRegistration[]) ?? []);
          }
        }
        break;

      case 'agent-joined': {
        const agent = message.agent as AgentRegistration;
        this.agentChangeHandlers.forEach(h => h({ type: 'join', agent }));
        break;
      }

      case 'agent-left': {
        const agentId = message.agentId as string;
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
