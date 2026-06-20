import workerSource from './worker-source';
import type {
  NirnamBusOptions,
  NirnamMessage,
  SubscribeHandler,
  RequestHandler,
  UnsubscribeFn,
} from './types';

/**
 * Per-page ID used to prevent BroadcastChannel from re-delivering messages
 * to the same page that published them (those already arrive via SharedWorker).
 */
const PAGE_ID = Math.random().toString(36).slice(2);
const CHANNEL_NAME = 'nirnam-bus-v1';
const WORKER_NAME = 'nirnam-message-worker';

/**
 * Module-level Blob URL so all NirnamBus instances in the same page connect
 * to the same SharedWorker process (same URL + same name = same worker).
 */
let workerBlobUrl: string | null = null;

function resolveWorkerUrl(staticUrl?: string): string {
  if (staticUrl) return staticUrl;
  if (!workerBlobUrl) {
    const blob = new Blob([workerSource], { type: 'application/javascript' });
    workerBlobUrl = URL.createObjectURL(blob);
  }
  return workerBlobUrl;
}

/**
 * Three-layer hybrid message bus:
 *
 * Layer 1 — BroadcastChannel: cross-tab pub/sub fan-out, zero deployment.
 * Layer 2 — Blob URL SharedWorker: within-page subscriber registry and routing,
 *            including request-reply correlation.
 * Layer 3 — Static URL SharedWorker (opt-in via `workerUrl`): true cross-tab
 *            SharedWorker sharing when a static file can be served.
 */
export class NirnamBus {
  private readonly worker: SharedWorker;
  private readonly channel: BroadcastChannel | null;
  private readonly handlers = new Map<string, Set<SubscribeHandler>>();
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private readonly pending = new Map<string, {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private readonly subscribedTopics = new Set<string>();
  private readonly timeout: number;

  constructor(options: NirnamBusOptions = {}) {
    const { workerUrl, useBroadcastChannel = true, requestTimeout = 5000 } = options;

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

  /**
   * Subscribe to broadcast events on a topic (BROAD / fan-out).
   * Returns an unsubscribe function.
   */
  subscribe<T>(topic: string, handler: SubscribeHandler<T>): UnsubscribeFn {
    this._ensureSubscribed(topic);
    if (!this.handlers.has(topic)) {
      this.handlers.set(topic, new Set());
    }
    this.handlers.get(topic)!.add(handler as SubscribeHandler);
    return () => this._removeHandler(topic, handler as SubscribeHandler);
  }

  /**
   * Register a request handler for a topic (NARROW / request-reply).
   * Incoming requests are answered with the value returned by the handler.
   * Returns an unsubscribe function.
   */
  handle<Req, Res>(topic: string, handler: RequestHandler<Req, Res>): UnsubscribeFn {
    this._ensureSubscribed(topic);
    this.requestHandlers.set(topic, handler as RequestHandler);
    return () => {
      this.requestHandlers.delete(topic);
      this._checkUnsubscribe(topic);
    };
  }

  /**
   * Publish a message to all subscribers of a topic (BROAD).
   * Reaches within-page subscribers via SharedWorker and cross-tab
   * subscribers via BroadcastChannel.
   */
  publish<T>(topic: string, payload: T): void {
    this.worker.port.postMessage({ type: 'broadcast', topic, payload, sourcePageId: PAGE_ID });
    this.channel?.postMessage({ type: 'broadcast', topic, payload, sourcePageId: PAGE_ID });
  }

  /**
   * Send a request to a handler registered on a topic (NARROW).
   * Returns a Promise that resolves with the handler's response.
   */
  request<Req, Res>(topic: string, payload: Req, timeout?: number): Promise<Res> {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const ms = timeout ?? this.timeout;

    return new Promise<Res>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`[Nirnam] Request on "${topic}" timed out after ${ms}ms`));
      }, ms);
      this.pending.set(requestId, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.worker.port.postMessage({ type: 'request', topic, payload, requestId });
    });
  }

  /** Close the worker port and BroadcastChannel. */
  close(): void {
    this.worker.port.close();
    this.channel?.close();
  }

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
    if (!hasHandlers && !hasRequestHandler && this.subscribedTopics.has(topic)) {
      this.subscribedTopics.delete(topic);
      this.worker.port.postMessage({ type: 'unsubscribe', topic });
    }
  }

  private _handleWorkerMessage(event: MessageEvent<NirnamMessage>): void {
    const { type, topic, payload, requestId, error } = event.data;

    switch (type) {
      case 'broadcast':
        if (topic) this.handlers.get(topic)?.forEach(h => h(payload));
        break;

      case 'request':
        if (topic && requestId) {
          const handler = this.requestHandlers.get(topic);
          if (handler) {
            Promise.resolve(handler(payload))
              .then(result => {
                this.worker.port.postMessage({ type: 'response', requestId, payload: result });
              })
              .catch(err => {
                this.worker.port.postMessage({ type: 'error', requestId, error: String(err.message) });
              });
          }
        }
        break;

      case 'response':
        if (requestId) {
          const p = this.pending.get(requestId);
          if (p) {
            clearTimeout(p.timer);
            this.pending.delete(requestId);
            p.resolve(payload);
          }
        }
        break;

      case 'error':
        if (requestId) {
          const p = this.pending.get(requestId);
          if (p) {
            clearTimeout(p.timer);
            this.pending.delete(requestId);
            p.reject(new Error(`[Nirnam] ${error ?? 'Unknown error'}`));
          }
        }
        break;
    }
  }

  private _handleChannelMessage(event: MessageEvent<NirnamMessage>): void {
    const { type, topic, payload, sourcePageId } = event.data;
    if (sourcePageId === PAGE_ID) return; // already delivered via SharedWorker
    if (type === 'broadcast' && topic) {
      this.handlers.get(topic)?.forEach(h => h(payload));
    }
  }
}

/**
 * Create a new NirnamBus instance. Each instance opens its own port to the
 * shared SharedWorker process (same Blob URL + name = same worker, different port).
 */
export function createBus(options?: NirnamBusOptions): NirnamBus {
  return new NirnamBus(options);
}
