/**
 * The worker side of the raw postMessage arm — a hub, hand-rolled. Page
 * publishes are fanned back out to the page (as a hub would), page requests
 * for topics the worker does not own are forwarded to the page and the
 * reply relayed, and three topics are answered here: ready, echo, and
 * "publish N messages on this topic".
 */

interface Envelope {
  type: 'publish' | 'request' | 'reply';
  topic?: string;
  id?: number;
  payload?: unknown;
  result?: unknown;
  error?: string;
}

const scope = self as unknown as { postMessage(m: Envelope): void; addEventListener(t: 'message', l: (e: MessageEvent<Envelope>) => void): void };

const own: Record<string, (payload: unknown) => unknown> = {
  ready: () => true,
  echo: payload => payload,
  'publish-many': payload => {
    const { topic, count } = payload as { topic: string; count: number };
    for (let seq = 0; seq < count; seq++) {
      scope.postMessage({ type: 'publish', topic, payload: { seq, sentAt: Date.now(), speaker: 'worker', text: 'a transcript line from the worker' } });
    }
    return count;
  },
};

// Requests forwarded to the page, keyed by the id we gave them, mapped back to the page's own id.
const forwarded = new Map<number, number>();
let nextForwardId = 1_000_000;

scope.addEventListener('message', event => {
  const m = event.data;
  switch (m.type) {
    case 'publish':
      scope.postMessage(m);
      break;
    case 'request': {
      const handler = own[m.topic!];
      if (handler) {
        try {
          scope.postMessage({ type: 'reply', id: m.id, result: handler(m.payload) });
        } catch (e) {
          scope.postMessage({ type: 'reply', id: m.id, error: String(e) });
        }
      } else {
        const id = nextForwardId++;
        forwarded.set(id, m.id!);
        scope.postMessage({ type: 'request', id, topic: m.topic, payload: m.payload });
      }
      break;
    }
    case 'reply': {
      const original = forwarded.get(m.id!);
      if (original === undefined) return;
      forwarded.delete(m.id!);
      scope.postMessage({ ...m, id: original });
      break;
    }
  }
});
