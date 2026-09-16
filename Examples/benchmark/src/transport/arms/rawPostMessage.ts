/**
 * Without Nirnam, a worker of your own: `worker.postMessage` and a message
 * envelope you invent. Pub/sub between page and worker is a switch on
 * `type`; request-reply is a correlation id, a pending map and a timeout;
 * a second worker, an iframe or another tab would each mean more of the
 * same. It is the honest counterfactual for the worker arm — the traffic
 * pattern is identical, so the numbers should be close; the lines are not.
 */

import type { TransportArm, Handler, RequestHandler } from '../arm';

interface Envelope {
  type: 'publish' | 'request' | 'reply';
  topic?: string;
  id?: number;
  payload?: unknown;
  result?: unknown;
  error?: string;
}

export function rawPostMessageArm(): TransportArm {
  let worker: Worker | null = null;
  const handlers = new Map<string, Set<Handler>>();
  const requestHandlers = new Map<string, RequestHandler>();
  const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void; timer: number }>();
  let nextId = 0;

  const send = (message: Envelope) => {
    if (!worker) throw new Error('arm not set up');
    worker.postMessage(message);
  };

  const onMessage = (event: MessageEvent<Envelope>) => {
    const m = event.data;
    switch (m.type) {
      case 'publish':
        handlers.get(m.topic!)?.forEach(h => h(m.payload));
        break;
      case 'reply': {
        const p = pending.get(m.id!);
        if (!p) return;
        pending.delete(m.id!);
        clearTimeout(p.timer);
        if (m.error) p.reject(new Error(m.error));
        else p.resolve(m.result);
        break;
      }
      case 'request': {
        const handler = requestHandlers.get(m.topic!);
        Promise.resolve()
          .then(() => {
            if (!handler) throw new Error(`no handler for ${m.topic}`);
            return handler(m.payload);
          })
          .then(result => send({ type: 'reply', id: m.id, result }), e => send({ type: 'reply', id: m.id, error: String(e) }));
        break;
      }
    }
  };

  const request = (topic: string, payload: unknown, timeoutMs = 5000) =>
    new Promise<unknown>((resolve, reject) => {
      const id = nextId++;
      const timer = window.setTimeout(() => {
        pending.delete(id);
        reject(new Error(`request ${topic} timed out`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      send({ type: 'request', id, topic, payload });
    });

  return {
    id: 'raw-postmessage',
    label: 'Raw postMessage worker',
    note: 'no Nirnam · one worker · envelope, correlation and timeouts hand-rolled',
    async setup() {
      worker = new Worker(new URL('../raw-echo.worker.ts', import.meta.url), { type: 'module' });
      worker.addEventListener('message', onMessage);
      await request('ready', null);
    },
    async teardown() {
      worker?.removeEventListener('message', onMessage);
      worker?.terminate();
      worker = null;
      pending.forEach(p => clearTimeout(p.timer));
      pending.clear();
      handlers.clear();
      requestHandlers.clear();
    },
    // Page-side pub/sub goes through the worker and back, as a shared hub would.
    subscribe(topic, handler) {
      if (!handlers.has(topic)) handlers.set(topic, new Set());
      handlers.get(topic)!.add(handler);
      return () => handlers.get(topic)?.delete(handler);
    },
    publish(topic, payload) {
      send({ type: 'publish', topic, payload });
    },
    handle(topic, handler) {
      requestHandlers.set(topic, handler);
      return () => requestHandlers.delete(topic);
    },
    request: (topic, payload) => request(topic, payload),
    async workerPublish(topic, count) {
      await request('publish-many', { topic, count });
    },
    workerRequest: payload => request('echo', payload),
  };
}
