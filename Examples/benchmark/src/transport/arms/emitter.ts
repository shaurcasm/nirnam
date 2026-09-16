/**
 * Without Nirnam, main thread only: an in-memory emitter — the singleton a
 * Module Federation host would share with its remotes. Delivery is a
 * synchronous loop over the handlers; nothing crosses a thread, nothing is
 * cloned. This is the arm Nirnam does not beat on latency, and the table
 * shows it. What it cannot do is also in the table: a worker, an iframe,
 * another tab, a timeout, a stream — each one is code you write.
 */

import type { TransportArm, Handler, RequestHandler, StreamHandler } from '../arm';

export function emitterArm(): TransportArm {
  const handlers = new Map<string, Set<Handler>>();
  const requestHandlers = new Map<string, RequestHandler>();
  const streamHandlers = new Map<string, StreamHandler>();
  return {
    id: 'emitter',
    label: 'In-memory emitter',
    note: 'no Nirnam · main thread only · synchronous dispatch',
    async setup() {},
    async teardown() {
      handlers.clear();
      requestHandlers.clear();
      streamHandlers.clear();
    },
    subscribe(topic, handler) {
      if (!handlers.has(topic)) handlers.set(topic, new Set());
      handlers.get(topic)!.add(handler);
      return () => handlers.get(topic)?.delete(handler);
    },
    publish(topic, payload) {
      handlers.get(topic)?.forEach(h => h(payload));
    },
    handle(topic, handler) {
      requestHandlers.set(topic, handler);
      return () => requestHandlers.delete(topic);
    },
    async request(topic, payload) {
      const handler = requestHandlers.get(topic);
      if (!handler) throw new Error(`no handler for ${topic}`);
      return handler(payload);
    },
    handleStream(topic, handler) {
      streamHandlers.set(topic, handler);
      return () => streamHandlers.delete(topic);
    },
    requestStream(topic, payload) {
      const handler = streamHandlers.get(topic);
      if (!handler) throw new Error(`no stream handler for ${topic}`);
      return handler(payload);
    },
  };
}
