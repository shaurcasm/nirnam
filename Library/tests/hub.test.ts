/**
 * Unit tests for MessageHub — the routing core shared by every hub kind.
 *
 * The hub knows nothing about workers. It is handed ports, sets their
 * `onmessage`, and routes between them. These tests drive it with plain fake
 * ports so every branch is exercised without a worker, a channel, or a bus.
 */

import { MessageHub } from '../src/hub';
import type { HubPort } from '../src/hub';

interface FakePort extends HubPort {
  postMessage: jest.Mock;
  start: jest.Mock;
  addEventListener: jest.Mock;
  /** Deliver a message as if the other end had posted it. */
  send(data: unknown, ports?: HubPort[]): void;
  /** Fire the 'close' listener the hub registered, if any. */
  emitClose(): void;
}

function fakePort(): FakePort {
  const closeListeners: Array<() => void> = [];
  const port: FakePort = {
    onmessage: null,
    postMessage: jest.fn(),
    start: jest.fn(),
    addEventListener: jest.fn((type: string, listener: () => void) => {
      if (type === 'close') closeListeners.push(listener);
    }),
    send(data, ports = []) {
      port.onmessage?.({ data, ports } as unknown as MessageEvent);
    },
    emitClose() {
      closeListeners.forEach(l => l());
    },
  };
  return port;
}

function lastPosted(port: FakePort): Record<string, unknown> {
  const calls = port.postMessage.mock.calls;
  return calls[calls.length - 1][0] as Record<string, unknown>;
}

let hub: MessageHub;
let a: FakePort;
let b: FakePort;

beforeEach(() => {
  hub = new MessageHub();
  a = fakePort();
  b = fakePort();
  hub.connect(a);
  hub.connect(b);
});

// --- connect / disconnect ----------------------------------------------------

describe('connect', () => {
  it('starts the port and listens for close', () => {
    expect(a.start).toHaveBeenCalledTimes(1);
    expect(a.addEventListener).toHaveBeenCalledWith('close', expect.any(Function));
    expect(hub.portCount).toBe(2);
  });

  it('tolerates ports without start or addEventListener', () => {
    const bare: HubPort = { onmessage: null, postMessage: jest.fn() };
    expect(() => hub.connect(bare)).not.toThrow();
    expect(hub.portCount).toBe(3);
  });

  it('adopts a port carried by a connect message', () => {
    const c = fakePort();
    a.send({ type: 'connect' }, [c]);

    expect(hub.portCount).toBe(3);
    c.send({ type: 'subscribe', topic: 't' });
    a.send({ type: 'broadcast', topic: 't', payload: 1 });
    expect(c.postMessage).toHaveBeenCalledWith({ type: 'broadcast', topic: 't', payload: 1, sourcePageId: undefined });
  });

  it('ignores a connect message with no port', () => {
    a.send({ type: 'connect' });
    expect(hub.portCount).toBe(2);
  });

  it('lets the introducer remove an adopted port by id — a terminated worker never closes its own', () => {
    const c = fakePort();
    a.send({ type: 'connect', portId: 'w1' }, [c]);
    c.send({ type: 'subscribe', topic: 't' });

    a.send({ type: 'disconnect-port', portId: 'w1' });

    expect(hub.portCount).toBe(2);
    a.send({ type: 'broadcast', topic: 't', payload: 1 });
    expect(c.postMessage).not.toHaveBeenCalled();
  });

  it('ignores disconnect-port for an unknown or already-gone id', () => {
    const c = fakePort();
    a.send({ type: 'connect', portId: 'w1' }, [c]);
    hub.disconnect(c);
    expect(() => a.send({ type: 'disconnect-port', portId: 'w1' })).not.toThrow();
    expect(() => a.send({ type: 'disconnect-port', portId: 'never' })).not.toThrow();
    expect(hub.portCount).toBe(2);
  });
});

describe('disconnect', () => {
  it('removes subscriptions, pending requests, agents and watchers for the port', () => {
    a.send({ type: 'subscribe', topic: 't' });
    a.send({ type: 'watch-agents' });
    a.send({ type: 'register', agentId: 'agent-a' });
    b.send({ type: 'watch-agents' });

    hub.disconnect(a);

    expect(hub.portCount).toBe(1);
    b.send({ type: 'broadcast', topic: 't', payload: 1 });
    expect(a.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'broadcast' }));
    expect(b.postMessage).toHaveBeenCalledWith({ type: 'agent-left', agentId: 'agent-a' });
  });

  it('is triggered by a disconnect message', () => {
    a.send({ type: 'disconnect' });
    expect(hub.portCount).toBe(1);
  });

  it('is triggered by the port closing', () => {
    a.emitClose();
    expect(hub.portCount).toBe(1);
  });

  it('is idempotent', () => {
    hub.disconnect(a);
    hub.disconnect(a);
    expect(hub.portCount).toBe(1);
  });
});

// --- pub/sub -----------------------------------------------------------------

describe('broadcast', () => {
  it('fans out to every subscriber of the topic, including the sender', () => {
    a.send({ type: 'subscribe', topic: 't' });
    b.send({ type: 'subscribe', topic: 't' });
    a.send({ type: 'broadcast', topic: 't', payload: 'x', sourcePageId: 'p1' });

    const expected = { type: 'broadcast', topic: 't', payload: 'x', sourcePageId: 'p1' };
    expect(a.postMessage).toHaveBeenCalledWith(expected);
    expect(b.postMessage).toHaveBeenCalledWith(expected);
  });

  it('delivers nothing on a topic with no subscribers', () => {
    a.send({ type: 'broadcast', topic: 'none', payload: 1 });
    expect(a.postMessage).not.toHaveBeenCalled();
    expect(b.postMessage).not.toHaveBeenCalled();
  });

  it('stops delivering after unsubscribe', () => {
    b.send({ type: 'subscribe', topic: 't' });
    b.send({ type: 'unsubscribe', topic: 't' });
    a.send({ type: 'broadcast', topic: 't', payload: 1 });
    expect(b.postMessage).not.toHaveBeenCalled();
  });

  it('ignores unsubscribe for an unknown topic', () => {
    expect(() => b.send({ type: 'unsubscribe', topic: 'never' })).not.toThrow();
  });
});

// --- request / reply ---------------------------------------------------------

describe('request', () => {
  it('routes to a handler and the response back to the origin', () => {
    b.send({ type: 'subscribe', topic: 'sum' });
    a.send({ type: 'request', topic: 'sum', payload: [1, 2], requestId: 'r1' });
    expect(lastPosted(b)).toEqual({ type: 'request', topic: 'sum', payload: [1, 2], requestId: 'r1' });

    b.send({ type: 'response', requestId: 'r1', payload: 3 });
    expect(lastPosted(a)).toEqual({ type: 'response', requestId: 'r1', payload: 3 });
  });

  it('errors with NO_HANDLER when nobody subscribes', () => {
    a.send({ type: 'request', topic: 'nobody', payload: null, requestId: 'r1' });
    expect(lastPosted(a)).toMatchObject({ type: 'error', requestId: 'r1', code: 'NO_HANDLER' });
  });

  it('round-robins between handlers', () => {
    const c = fakePort();
    hub.connect(c);
    b.send({ type: 'subscribe', topic: 't' });
    c.send({ type: 'subscribe', topic: 't' });

    a.send({ type: 'request', topic: 't', payload: 0, requestId: 'r1' });
    a.send({ type: 'request', topic: 't', payload: 0, requestId: 'r2' });
    a.send({ type: 'request', topic: 't', payload: 0, requestId: 'r3' });

    expect(b.postMessage).toHaveBeenCalledTimes(2);
    expect(c.postMessage).toHaveBeenCalledTimes(1);
  });

  it('rejects a response with no pending request', () => {
    b.send({ type: 'response', requestId: 'ghost', payload: 1 });
    expect(lastPosted(b)).toMatchObject({ type: 'error', requestId: 'ghost', code: 'HANDLER_REJECTED' });
  });

  it('forwards a handler error to the origin', () => {
    b.send({ type: 'subscribe', topic: 't' });
    a.send({ type: 'request', topic: 't', payload: 0, requestId: 'r1' });
    b.send({ type: 'error', requestId: 'r1', error: 'boom', code: 'HANDLER_REJECTED' });
    expect(lastPosted(a)).toEqual({ type: 'error', requestId: 'r1', error: 'boom', code: 'HANDLER_REJECTED' });
  });

  it('drops a handler error with no pending request', () => {
    b.send({ type: 'error', requestId: 'ghost', error: 'boom' });
    expect(a.postMessage).not.toHaveBeenCalled();
  });
});

// --- streaming ---------------------------------------------------------------

describe('request-stream', () => {
  it('relays chunks and end to the origin, then forgets the request', () => {
    b.send({ type: 'subscribe', topic: 's' });
    a.send({ type: 'request-stream', topic: 's', payload: null, requestId: 'r1' });
    expect(lastPosted(b)).toMatchObject({ type: 'request-stream', requestId: 'r1' });

    b.send({ type: 'stream-chunk', requestId: 'r1', payload: 'one' });
    b.send({ type: 'stream-end', requestId: 'r1' });
    b.send({ type: 'stream-chunk', requestId: 'r1', payload: 'late' });

    expect(a.postMessage.mock.calls.map(c => c[0])).toEqual([
      { type: 'stream-chunk', requestId: 'r1', payload: 'one' },
      { type: 'stream-end', requestId: 'r1' },
    ]);
  });

  it('ignores chunks and end for unknown requests', () => {
    b.send({ type: 'stream-chunk', requestId: 'ghost', payload: 1 });
    b.send({ type: 'stream-end', requestId: 'ghost' });
    expect(a.postMessage).not.toHaveBeenCalled();
  });
});

// --- agents ------------------------------------------------------------------

describe('agents', () => {
  it('notifies watchers on join and lists registered agents', () => {
    a.send({ type: 'watch-agents' });
    b.send({ type: 'register', agentId: 'x', capabilities: ['chat'], metadata: { v: 1 } });

    const reg = { agentId: 'x', capabilities: ['chat'], metadata: { v: 1 } };
    expect(lastPosted(a)).toEqual({ type: 'agent-joined', agent: reg });

    a.send({ type: 'discover', requestId: 'd1' });
    expect(lastPosted(a)).toEqual({ type: 'agent-list', requestId: 'd1', agents: [reg] });
  });

  it('notifies watchers on leave when the owning port disconnects', () => {
    a.send({ type: 'watch-agents' });
    b.send({ type: 'register', agentId: 'x' });
    hub.disconnect(b);
    expect(lastPosted(a)).toEqual({ type: 'agent-left', agentId: 'x' });
  });
});

// --- validation --------------------------------------------------------------

describe('validation', () => {
  it.each([
    [{ type: 'subscribe' }, 'subscribe requires a topic'],
    [{ type: 'unsubscribe' }, 'unsubscribe requires a topic'],
    [{ type: 'broadcast' }, 'broadcast requires a topic'],
    [{ type: 'request', topic: 't' }, 'request requires topic and requestId'],
    [{ type: 'request-stream', requestId: 'r' }, 'request-stream requires topic and requestId'],
    [{ type: 'response' }, 'response requires requestId'],
    [{ type: 'stream-chunk' }, 'stream-chunk requires requestId'],
    [{ type: 'stream-end' }, 'stream-end requires requestId'],
    [{ type: 'register' }, 'register requires agentId'],
    [{ type: 'discover' }, 'discover requires requestId'],
    [{ type: 'disconnect-port' }, 'disconnect-port requires portId'],
    [{ type: 'bogus' }, 'Unknown message type: "bogus"'],
  ])('replies with an error for %j', (message, error) => {
    a.send(message);
    expect(lastPosted(a)).toMatchObject({ type: 'error', error });
  });

  it('ignores non-object messages', () => {
    expect(() => a.send(null)).not.toThrow();
    expect(() => a.send('str')).not.toThrow();
    expect(a.postMessage).not.toHaveBeenCalled();
  });
});
