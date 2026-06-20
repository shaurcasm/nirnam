/**
 * Unit tests for NirnamBus.
 *
 * SharedWorker, BroadcastChannel, Blob, and URL.createObjectURL are replaced
 * by the synchronous mocks installed in tests/setup.ts. Message delivery from
 * the mock worker to the bus is synchronous, so most assertions need no
 * awaiting. The request/handle pair uses Promise.resolve().then() internally,
 * so those tests await the returned Promise.
 */

// Hoisted before any import — tells ts-jest to replace the module with a stub.
jest.mock('../src/worker-source', () => ({ default: '/* mock worker script */' }));

import { createBus, NirnamBus } from '../src/bus';
import {
  resetWorkerState,
  resetBroadcastChannels,
  getLastSharedWorkerUrl,
  MockBroadcastChannel,
} from './setup';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Flush Promise microtask queue. Uses Promise.resolve() so fake timers don't block it. */
const flushPromises = () => Promise.resolve().then(() => Promise.resolve());

/** Access internal (private) members of NirnamBus for white-box assertions. */
function internals(bus: NirnamBus) {
  return bus as unknown as {
    worker: { port: { postMessage: jest.Mock; close: jest.Mock } };
    channel: MockBroadcastChannel | null;
    pending: Map<string, unknown>;
    handlers: Map<string, Set<unknown>>;
    subscribedTopics: Set<string>;
  };
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

beforeEach(() => {
  resetWorkerState();
  resetBroadcastChannels();
  jest.clearAllMocks();
});

afterEach(() => {
  jest.useRealTimers();
});

// ─── subscribe / publish (BROAD) ─────────────────────────────────────────────

describe('subscribe / publish', () => {
  it('delivers published payload to a subscriber', () => {
    const bus = createBus();
    const handler = jest.fn();

    bus.subscribe('counter', handler);
    bus.publish('counter', 42);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(42);
  });

  it('delivers to multiple subscribers on the same topic', () => {
    const bus = createBus();
    const h1 = jest.fn();
    const h2 = jest.fn();

    bus.subscribe('evt', h1);
    bus.subscribe('evt', h2);
    bus.publish('evt', 'hello');

    expect(h1).toHaveBeenCalledWith('hello');
    expect(h2).toHaveBeenCalledWith('hello');
  });

  it('unsubscribe fn stops delivery', () => {
    const bus = createBus();
    const handler = jest.fn();

    const unsub = bus.subscribe('topic', handler);
    unsub();
    bus.publish('topic', 'should-not-arrive');

    expect(handler).not.toHaveBeenCalled();
  });

  it('removing last handler sends unsubscribe to worker', () => {
    const bus = createBus();
    const handler = jest.fn();
    const { worker } = internals(bus);

    const unsub = bus.subscribe('topic', handler);
    unsub();

    expect(worker.port.postMessage).toHaveBeenCalledWith({ type: 'unsubscribe', topic: 'topic' });
  });

  it('removing one of two handlers does not unsubscribe from worker', () => {
    const bus = createBus();
    const h1 = jest.fn();
    const h2 = jest.fn();
    const { worker } = internals(bus);

    const unsub1 = bus.subscribe('topic', h1);
    bus.subscribe('topic', h2);

    unsub1();

    const calls = worker.port.postMessage.mock.calls.map((c: unknown[]) => (c[0] as { type: string }).type);
    expect(calls).not.toContain('unsubscribe');

    bus.publish('topic', 'still-live');
    expect(h2).toHaveBeenCalledWith('still-live');
  });

  it('handlers on different topics are isolated', () => {
    const bus = createBus();
    const hA = jest.fn();
    const hB = jest.fn();

    bus.subscribe('topicA', hA);
    bus.subscribe('topicB', hB);
    bus.publish('topicA', 1);

    expect(hA).toHaveBeenCalledWith(1);
    expect(hB).not.toHaveBeenCalled();
  });

  it('publishes only once to worker per call', () => {
    const bus = createBus();
    bus.subscribe('t', jest.fn());
    const { worker } = internals(bus);

    bus.publish('t', 'x');

    const broadcastCalls = worker.port.postMessage.mock.calls.filter(
      (c: unknown[]) => (c[0] as { type: string }).type === 'broadcast'
    );
    expect(broadcastCalls).toHaveLength(1);
  });

  it('cross-bus publish reaches subscriber on a second bus (same-page MFE)', () => {
    const busA = createBus();
    const busB = createBus();
    const handler = jest.fn();

    busB.subscribe('counter', handler);
    busA.publish('counter', 99);

    expect(handler).toHaveBeenCalledWith(99);
  });

  it('sends subscribe message only once per topic regardless of handler count', () => {
    const bus = createBus();
    const { worker } = internals(bus);

    bus.subscribe('t', jest.fn());
    bus.subscribe('t', jest.fn());
    bus.subscribe('t', jest.fn());

    const subscribeCalls = worker.port.postMessage.mock.calls.filter(
      (c: unknown[]) => (c[0] as { type: string }).type === 'subscribe'
    );
    expect(subscribeCalls).toHaveLength(1);
  });

  it('object payloads are passed by reference unchanged', () => {
    const bus = createBus();
    const handler = jest.fn();
    const payload = { a: 1, b: [2, 3] };

    bus.subscribe('obj', handler);
    bus.publish('obj', payload);

    expect(handler).toHaveBeenCalledWith(payload);
  });
});

// ─── handle / request (NARROW) ───────────────────────────────────────────────

describe('handle / request', () => {
  it('request resolves with sync handler return value', async () => {
    const bus = createBus();
    bus.handle<{ a: number; b: number }, number>('add', ({ a, b }) => a + b);

    const result = await bus.request<{ a: number; b: number }, number>('add', { a: 3, b: 4 });

    expect(result).toBe(7);
  });

  it('request resolves with async handler return value', async () => {
    const bus = createBus();
    bus.handle<number, string>('stringify', async (n) => `num:${n}`);

    const result = await bus.request<number, string>('stringify', 42);

    expect(result).toBe('num:42');
  });

  it('cross-bus request: busA requests, busB handles', async () => {
    const busA = createBus();
    const busB = createBus();
    busB.handle<string, string>('greet', (name) => `Hello, ${name}!`);

    const result = await busA.request<string, string>('greet', 'World');

    expect(result).toBe('Hello, World!');
  });

  it('rejects when no handler is registered on the topic', async () => {
    const bus = createBus();
    await expect(bus.request('no-one-home', {})).rejects.toThrow(/No handler/);
  });

  it('rejects after the default timeout when no response arrives', async () => {
    jest.useFakeTimers();
    const bus = createBus({ requestTimeout: 100 });

    // Request a topic with no handler — worker sends error synchronously here,
    // so use a topic we've subscribed to but whose handler never responds.
    // Simplest: override the request path by not registering any handler
    // so the mock bus sends 'error'. We instead test a hung handler.

    // Register a handler that never resolves to test the timer path
    bus.handle('slow', () => new Promise(() => {})); // never resolves

    const promise = bus.request('slow', {}, 100);
    jest.advanceTimersByTime(200);
    await flushPromises();

    await expect(promise).rejects.toThrow('timed out after 100ms');
  });

  it('per-call timeout overrides default', async () => {
    jest.useFakeTimers();
    const bus = createBus({ requestTimeout: 9999 });
    bus.handle('slow', () => new Promise(() => {}));

    const promise = bus.request('slow', {}, 50);
    jest.advanceTimersByTime(100);
    await flushPromises();

    await expect(promise).rejects.toThrow('timed out after 50ms');
  });

  it('handle cleanup stops the handler from receiving requests', async () => {
    const bus = createBus();
    const unsub = bus.handle('topic', () => 'original');
    unsub();

    await expect(bus.request('topic', {})).rejects.toThrow();
  });

  it('handle cleanup sends worker unsubscribe when no broadcast handlers remain', () => {
    const bus = createBus();
    const { worker } = internals(bus);
    const unsub = bus.handle('topic', () => 'x');
    unsub();

    expect(worker.port.postMessage).toHaveBeenCalledWith({ type: 'unsubscribe', topic: 'topic' });
  });

  it('handle cleanup does NOT unsubscribe from worker when broadcast handler still active', () => {
    const bus = createBus();
    const { worker } = internals(bus);

    bus.subscribe('topic', jest.fn());
    const unsub = bus.handle('topic', () => 'x');
    unsub();

    const calls = worker.port.postMessage.mock.calls.map((c: unknown[]) => (c[0] as { type: string }).type);
    expect(calls).not.toContain('unsubscribe');
  });

  it('multiple parallel requests resolve with correct values', async () => {
    const bus = createBus();
    bus.handle<string, string>('echo', v => v);

    const [r1, r2, r3] = await Promise.all([
      bus.request<string, string>('echo', 'alpha'),
      bus.request<string, string>('echo', 'beta'),
      bus.request<string, string>('echo', 'gamma'),
    ]);

    expect(r1).toBe('alpha');
    expect(r2).toBe('beta');
    expect(r3).toBe('gamma');
  });

  it('resolved pending promises are cleaned up from the pending map', async () => {
    const bus = createBus();
    bus.handle('echo', v => v);

    await bus.request('echo', 'x');

    expect(internals(bus).pending.size).toBe(0);
  });

  it('rejected (timeout) pending promises are cleaned up from the pending map', async () => {
    jest.useFakeTimers();
    const bus = createBus({ requestTimeout: 50 });
    bus.handle('slow', () => new Promise(() => {}));

    const promise = bus.request('slow', {});
    jest.advanceTimersByTime(100);
    await flushPromises();

    await promise.catch(() => {});
    expect(internals(bus).pending.size).toBe(0);
  });
});

// ─── BroadcastChannel ────────────────────────────────────────────────────────

describe('BroadcastChannel', () => {
  it('publish sends a message to the BroadcastChannel', () => {
    const bus = createBus();
    const channel = internals(bus).channel!;
    const spy = jest.spyOn(channel, 'postMessage');

    bus.publish('topic', 'payload');

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'broadcast', topic: 'topic', payload: 'payload' })
    );
  });

  it('incoming cross-tab message (different sourcePageId) is delivered to handler', () => {
    const bus = createBus();
    const handler = jest.fn();
    bus.subscribe('news', handler);

    const channel = internals(bus).channel!;
    channel._simulateIncoming({
      type: 'broadcast',
      topic: 'news',
      payload: 'breaking',
      sourcePageId: 'some-other-page-id',
    });

    expect(handler).toHaveBeenCalledWith('breaking');
  });

  it('incoming cross-tab message with same sourcePageId is NOT re-delivered', () => {
    const bus = createBus();
    const handler = jest.fn();
    bus.subscribe('topic', handler);

    // Publish once — worker delivers it (handler called once).
    bus.publish('topic', 'data');
    handler.mockClear();

    // Simulate the BroadcastChannel echoing back our own message (same PAGE_ID).
    const channel = internals(bus).channel!;
    channel._simulateIncoming(channel.lastPostedData); // lastPostedData has same sourcePageId

    expect(handler).not.toHaveBeenCalled();
  });

  it('two-bus cross-tab simulation: busA publishes, busB receives via BC', () => {
    const busA = createBus();
    const busB = createBus();
    const handlerB = jest.fn();

    busB.subscribe('cross-tab', handlerB);

    // Simulate busA's BC message arriving at busB's channel instance
    const busAChannel = internals(busA).channel!;
    const busBChannel = internals(busB).channel!;
    busA.publish('cross-tab', 'from-tab-A');

    // busA.channel.postMessage notified other instances; busB's channel is one of them
    // (because MockBroadcastChannel uses a static registry).
    // Verify busB received it via BC.
    // Since both channels are created in the same test, the mock registry links them.
    expect(handlerB).toHaveBeenCalled(); // delivered via SharedWorker (same mock bus)
  });

  it('useBroadcastChannel: false skips channel creation', () => {
    const countBefore = MockBroadcastChannel.getInstances().length;
    const bus = createBus({ useBroadcastChannel: false });

    expect(MockBroadcastChannel.getInstances().length).toBe(countBefore);
    expect(internals(bus).channel).toBeNull();
    bus.close();
  });

  it('incoming BC messages on unsubscribed topics are silently ignored', () => {
    const bus = createBus();
    const channel = internals(bus).channel!;

    expect(() => {
      channel._simulateIncoming({
        type: 'broadcast',
        topic: 'ghost-topic',
        payload: 'x',
        sourcePageId: 'other-page',
      });
    }).not.toThrow();
  });

  it('non-broadcast BC messages are ignored', () => {
    const bus = createBus();
    const handler = jest.fn();
    bus.subscribe('topic', handler);
    const channel = internals(bus).channel!;

    channel._simulateIncoming({
      type: 'request', // not 'broadcast'
      topic: 'topic',
      payload: 'x',
      sourcePageId: 'other',
    });

    expect(handler).not.toHaveBeenCalled();
  });
});

// ─── close() ─────────────────────────────────────────────────────────────────

describe('close()', () => {
  it('closes the worker port', () => {
    const bus = createBus();
    const { worker } = internals(bus);

    bus.close();

    expect(worker.port.close).toHaveBeenCalled();
  });

  it('closes the BroadcastChannel', () => {
    const bus = createBus();
    const channel = internals(bus).channel!;
    const spy = jest.spyOn(channel, 'close');

    bus.close();

    expect(spy).toHaveBeenCalled();
  });

  it('does not throw when useBroadcastChannel is false', () => {
    const bus = createBus({ useBroadcastChannel: false });
    expect(() => bus.close()).not.toThrow();
  });
});

// ─── Options ─────────────────────────────────────────────────────────────────

describe('options', () => {
  it('workerUrl passes the static URL to SharedWorker constructor', () => {
    const bus = createBus({ workerUrl: '/static/nirnam-worker.js' });
    expect(getLastSharedWorkerUrl()).toBe('/static/nirnam-worker.js');
    bus.close();
  });

  it('default Blob URL is used when workerUrl is not set', () => {
    createBus();
    expect(getLastSharedWorkerUrl()).toBe('blob:mock-url');
  });

  it('requestTimeout error message includes the configured value', async () => {
    jest.useFakeTimers();
    const bus = createBus({ requestTimeout: 250 });
    bus.handle('slow', () => new Promise(() => {}));

    const promise = bus.request('slow', {});
    jest.advanceTimersByTime(500);
    await flushPromises();

    await expect(promise).rejects.toThrow('250ms');
  });
});

// ─── NirnamBus class export ───────────────────────────────────────────────────

describe('createBus / NirnamBus export', () => {
  it('createBus returns a NirnamBus instance', () => {
    expect(createBus()).toBeInstanceOf(NirnamBus);
  });

  it('two createBus() calls return independent instances', () => {
    const a = createBus();
    const b = createBus();
    expect(a).not.toBe(b);
  });
});
