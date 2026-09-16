/**
 * Without Nirnam, main thread only: `window.dispatchEvent(new CustomEvent())`
 * — the other thing MFEs reach for when they must not import each other.
 * Pub/sub comes for free. Request-reply does not: it is a reply event, a
 * correlation id and a timeout, written here by hand so the arm can take
 * part in that workload — and so the effort panel can count the lines.
 */

import type { TransportArm, RequestHandler } from '../arm';

export function customEventArm(): TransportArm {
  let nextId = 0;
  const prefix = 'bench:';

  return {
    id: 'custom-event',
    label: 'window CustomEvent',
    note: 'no Nirnam · main thread only · request-reply hand-rolled',
    async setup() {},
    async teardown() {},
    subscribe(topic, handler) {
      const listener: EventListener = event => handler((event as CustomEvent).detail);
      window.addEventListener(prefix + topic, listener);
      return () => window.removeEventListener(prefix + topic, listener);
    },
    publish(topic, payload) {
      window.dispatchEvent(new CustomEvent(prefix + topic, { detail: payload }));
    },
    handle(topic, handler: RequestHandler) {
      const listener: EventListener = async event => {
        const { id, payload } = (event as CustomEvent).detail as { id: number; payload: unknown };
        try {
          const result = await handler(payload);
          window.dispatchEvent(new CustomEvent(`${prefix}reply:${id}`, { detail: { result } }));
        } catch (e) {
          window.dispatchEvent(new CustomEvent(`${prefix}reply:${id}`, { detail: { error: String(e) } }));
        }
      };
      window.addEventListener(`${prefix}req:${topic}`, listener);
      return () => window.removeEventListener(`${prefix}req:${topic}`, listener);
    },
    request(topic, payload) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          window.removeEventListener(`${prefix}reply:${id}`, onReply);
          reject(new Error(`request ${topic} timed out`));
        }, 5000);
        const onReply: EventListener = event => {
          clearTimeout(timer);
          window.removeEventListener(`${prefix}reply:${id}`, onReply);
          const { result, error } = (event as CustomEvent).detail as { result?: unknown; error?: string };
          if (error) reject(new Error(error));
          else resolve(result);
        };
        window.addEventListener(`${prefix}reply:${id}`, onReply);
        window.dispatchEvent(new CustomEvent(`${prefix}req:${topic}`, { detail: { id, payload } }));
      });
    },
  };
}
