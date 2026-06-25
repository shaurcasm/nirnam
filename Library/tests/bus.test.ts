/**
 * Unit tests for NirnamBus.
 *
 * SharedWorker, BroadcastChannel, Blob, and URL.createObjectURL are replaced
 * by the synchronous mocks installed in tests/setup.ts. Message delivery from
 * the mock worker to the bus is synchronous, so most assertions need no
 * awaiting. The request/handle pair uses Promise.resolve().then() internally,
 * so those tests await the returned Promise.
 */

// Hoisted before any import -- tells ts-jest to replace the module with a stub.
jest.mock('../src/worker-source', () => ({ default: '/* mock worker script */' }));

import { createBus, NirnamBus } from '../src/bus';
import { NirnamErrorCode, NirnamRequestError } from '../src/types';
import {
  resetWorkerState,
  resetBroadcastChannels,
  getLastSharedWorkerUrl,
  MockBroadcastChannel,
} from './setup';

// --- Helpers -----------------------------------------------------------------

/** Flush Promise microtask queue. Uses Promise.resolve() so fake timers don't block it. */
const flushPromises = () => Promise.resolve().then(() => Promise.resolve());

/** Access internal (private) members of NirnamBus for white-box assertions. */
function internals(bus: NirnamBus) {
  return bus as unknown as {
    worker: { port: { postMessage: jest.Mock; close: jest.Mock } };
    channel: MockBroadcastChannel | null;
    pending: Map<string, unknown>;
    pendingStreams: Map<string, unknown>;
    handlers: Map<string, Set<unknown>>;
    subscribedTopics: Set<string>;
  };
}

// --- Lifecycle ---------------------------------------------------------------

beforeEach(() => {
  resetWorkerState();
  resetBroadcastChannels();
  jest.clearAllMocks();
});

afterEach(() => {
  jest.useRealTimers();
});

// --- resolveWorkerUrl / Layer 3 static URL -----------------------------------

describe('resolveWorkerUrl', () => {
  it('uses blob URL by default (Layer 2)', () => {
    createBus();
    expect(getLastSharedWorkerUrl()).toBe('blob:mock-url');
  });

  it('uses explicit workerUrl option when provided', () => {
    createBus({ workerUrl: '/explicit-worker.js' });
    expect(getLastSharedWorkerUrl()).toBe('/explicit-worker.js');
  });

  describe('__NIRNAM_STATIC_WORKER_URL__ injection (Layer 3)', () => {
    beforeEach(() => {
      (globalThis as Record<string, unknown>).__NIRNAM_STATIC_WORKER_URL__ =
        '/nirnam-worker.js';
    });
    afterEach(() => {
      delete (globalThis as Record<string, unknown>).__NIRNAM_STATIC_WORKER_URL__;
    });

    it('uses the injected static URL when present', () => {
      createBus();
      expect(getLastSharedWorkerUrl()).toBe('/nirnam-worker.js');
    });

    it('explicit workerUrl option takes precedence over injected global', () => {
      createBus({ workerUrl: '/override.js' });
      expect(getLastSharedWorkerUrl()).toBe('/override.js');
    });
  });
});

// --- subscribe / publish (BROAD) ---------------------------------------------

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

// --- handle / request (NARROW) -----------------------------------------------

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

  it('rejects with NirnamRequestError(NO_HANDLER) when no handler registered', async () => {
    const bus = createBus();
    const err = await bus.request('no-one-home', {}).catch(e => e);

    expect(err).toBeInstanceOf(NirnamRequestError);
    expect(err.code).toBe(NirnamErrorCode.NO_HANDLER);
    expect(err.message).toMatch(/No handler/);
  });

  it('rejects with NirnamRequestError(TIMEOUT) after timeout elapses', async () => {
    jest.useFakeTimers();
    const bus = createBus({ requestTimeout: 100 });
    bus.handle('slow', () => new Promise(() => {})); // never resolves

    const promise = bus.request('slow', {}, 100);
    jest.advanceTimersByTime(200);
    await flushPromises();

    const err = await promise.catch(e => e);
    expect(err).toBeInstanceOf(NirnamRequestError);
    expect(err.code).toBe(NirnamErrorCode.TIMEOUT);
    expect(err.message).toMatch(/timed out after 100ms/);
  });

  it('rejects with NirnamRequestError(HANDLER_REJECTED) when handler throws', async () => {
    const bus = createBus();
    bus.handle('explode', () => { throw new Error('boom'); });

    const err = await bus.request('explode', {}).catch(e => e);
    expect(err).toBeInstanceOf(NirnamRequestError);
    expect(err.code).toBe(NirnamErrorCode.HANDLER_REJECTED);
    expect(err.message).toMatch(/boom/);
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

  it('routes successive requests round-robin across multiple handlers', async () => {
    const busA = createBus();
    const busB = createBus();
    const busC = createBus();

    busA.handle<number, string>('compute', n => `A:${n}`);
    busB.handle<number, string>('compute', n => `B:${n}`);

    const r1 = await busC.request<number, string>('compute', 1);
    const r2 = await busC.request<number, string>('compute', 2);
    const r3 = await busC.request<number, string>('compute', 3);

    expect(r1).toBe('A:1');
    expect(r2).toBe('B:2');
    expect(r3).toBe('A:3');
  });

  it('handle cleanup stops the handler from receiving requests', async () => {
    const bus = createBus();
    const unsub = bus.handle('topic', () => 'original');
    unsub();

    await expect(bus.request('topic', {})).rejects.toBeInstanceOf(NirnamRequestError);
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

// --- handleStream / requestStream (NARROW streaming) ------------------------

describe('handleStream / requestStream', () => {
  it('delivers all chunks in order and completes', async () => {
    const busA = createBus();
    const busB = createBus();

    busA.handleStream<number, number>('squares', async function* (n) {
      for (let i = 1; i <= n; i++) yield i * i;
    });

    const results: number[] = [];
    for await (const chunk of busB.requestStream<number, number>('squares', 3)) {
      results.push(chunk);
    }

    expect(results).toEqual([1, 4, 9]);
  });

  it('delivers string chunks cross-bus', async () => {
    const busA = createBus();
    const busB = createBus();

    busA.handleStream<string, string>('words', async function* (sentence) {
      for (const word of sentence.split(' ')) yield word;
    });

    const words: string[] = [];
    for await (const w of busB.requestStream<string, string>('words', 'hello world foo')) {
      words.push(w);
    }

    expect(words).toEqual(['hello', 'world', 'foo']);
  });

  it('single-item stream works correctly', async () => {
    const bus = createBus();
    bus.handleStream('single', async function* () { yield 'only'; });

    const results: string[] = [];
    for await (const chunk of bus.requestStream<void, string>('single', undefined as unknown as void)) {
      results.push(chunk);
    }

    expect(results).toEqual(['only']);
  });

  it('empty stream completes without yielding', async () => {
    const bus = createBus();
    bus.handleStream('empty', async function* () { /* nothing */ });

    const results: unknown[] = [];
    for await (const chunk of bus.requestStream('empty', null)) {
      results.push(chunk);
    }

    expect(results).toHaveLength(0);
  });

  it('stream error mid-way propagates as NirnamRequestError', async () => {
    const busA = createBus();
    const busB = createBus();

    busA.handleStream('fail-mid', async function* () {
      yield 'first';
      throw new Error('mid-stream failure');
    });

    const iter = busB.requestStream<null, string>('fail-mid', null)[Symbol.asyncIterator]();

    const first = await iter.next();
    expect(first.value).toBe('first');
    expect(first.done).toBe(false);

    await expect(iter.next()).rejects.toBeInstanceOf(NirnamRequestError);
  });

  it('requestStream rejects with NirnamRequestError(NO_HANDLER) when no stream handler', async () => {
    const bus = createBus();

    const iter = bus.requestStream('ghost-stream', {})[Symbol.asyncIterator]();
    const err = await iter.next().catch(e => e);

    expect(err).toBeInstanceOf(NirnamRequestError);
    expect(err.code).toBe(NirnamErrorCode.NO_HANDLER);
  });

  it('requestStream routed to a broadcast-only subscriber sends NO_HANDLER error (bus.ts:309)', async () => {
    // busA only has a subscribe() handler (no handleStream) but IS in the
    // worker registry for the topic, so the worker routes the stream request to it.
    // busA must respond with NO_HANDLER since it has no stream handler.
    const busA = createBus();
    const busB = createBus();

    busA.subscribe('data', jest.fn()); // registers busA for 'data', but no stream handler

    const iter = busB.requestStream<unknown, string>('data', null)[Symbol.asyncIterator]();
    const err = await iter.next().catch(e => e);

    expect(err).toBeInstanceOf(NirnamRequestError);
    expect(err.code).toBe(NirnamErrorCode.NO_HANDLER);
    busA.close();
    busB.close();
  });

  it('handleStream cleanup sends unsubscribe when no other handlers remain', () => {
    const bus = createBus();
    const { worker } = internals(bus);
    const unsub = bus.handleStream('topic', async function* () {});
    unsub();

    expect(worker.port.postMessage).toHaveBeenCalledWith({ type: 'unsubscribe', topic: 'topic' });
  });

  it('handleStream cleanup does NOT unsubscribe when broadcast handler still active', () => {
    const bus = createBus();
    const { worker } = internals(bus);

    bus.subscribe('topic', jest.fn());
    const unsub = bus.handleStream('topic', async function* () {});
    unsub();

    const calls = worker.port.postMessage.mock.calls.map((c: unknown[]) => (c[0] as { type: string }).type);
    expect(calls).not.toContain('unsubscribe');
  });

  it('pendingStreams map is cleaned up after stream completes', async () => {
    const bus = createBus();
    bus.handleStream('ch', async function* () { yield 1; });

    for await (const _ of bus.requestStream('ch', null)) { /* consume */ }

    expect(internals(bus).pendingStreams.size).toBe(0);
  });

  it('pendingStreams map is cleaned up after stream error', async () => {
    const busA = createBus();
    const busB = createBus();

    busA.handleStream('err-ch', async function* () { throw new Error('abort'); });

    const iter = busB.requestStream('err-ch', null)[Symbol.asyncIterator]();
    await iter.next().catch(() => {});

    expect(internals(busB).pendingStreams.size).toBe(0);
  });
});

// --- BroadcastChannel --------------------------------------------------------

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

    bus.publish('topic', 'data');
    handler.mockClear();

    const channel = internals(bus).channel!;
    channel._simulateIncoming(channel.lastPostedData);

    expect(handler).not.toHaveBeenCalled();
  });

  it('two-bus cross-tab simulation: busA publishes, busB receives via BC', () => {
    const busA = createBus();
    const busB = createBus();
    const handlerB = jest.fn();

    busB.subscribe('cross-tab', handlerB);
    busA.publish('cross-tab', 'from-tab-A');

    expect(handlerB).toHaveBeenCalled();
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

  it('BC message arrives after all handlers for the topic are removed (?.forEach null branch)', () => {
    // Covers `this.handlers.get(topic)?.forEach()` null branch in _handleChannelMessage.
    const busA = createBus();
    const busB = createBus();
    const handler = jest.fn();

    const unsub = busB.subscribe('volatile', handler);
    unsub(); // removes handler and deletes the handlers Set for this topic

    // busA publish goes to BC; busB channel message handler fires but handlers map has no entry
    expect(() => busA.publish('volatile', 'late')).not.toThrow();
    expect(handler).not.toHaveBeenCalled();
    busA.close();
    busB.close();
  });

  it('non-broadcast BC messages are ignored', () => {
    const bus = createBus();
    const handler = jest.fn();
    bus.subscribe('topic', handler);
    const channel = internals(bus).channel!;

    channel._simulateIncoming({
      type: 'request',
      topic: 'topic',
      payload: 'x',
      sourcePageId: 'other',
    });

    expect(handler).not.toHaveBeenCalled();
  });
});

// --- close() -----------------------------------------------------------------

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

// --- Options -----------------------------------------------------------------

describe('options', () => {
  it('dispatchDOMEvents: true with no window global — publish does not throw', () => {
    // Covers the `dispatchDOMEvents && typeof window !== 'undefined'` false branch
    // when dispatchDOMEvents is true but window is not defined (Node env, no mock).
    const bus = createBus({ dispatchDOMEvents: true });
    expect(() => bus.publish('counter', 42)).not.toThrow();
    bus.close();
  });

  it('publish with useBroadcastChannel: false does not call channel.postMessage', () => {
    // Covers the `this.channel?.postMessage()` null branch (channel is null).
    const bus = createBus({ useBroadcastChannel: false });
    expect(() => bus.publish('topic', 'value')).not.toThrow();
    bus.close();
  });

  it('calling an unsubscribe fn twice does not throw (defensive null-set guard)', () => {
    // Covers the `if (!set) return` early-return branch in _removeHandler.
    // First call cleans up the Set; second call finds nothing and returns early.
    const bus = createBus();
    const unsub = bus.subscribe('topic', jest.fn());
    unsub();
    expect(() => unsub()).not.toThrow();
  });

  it('broadcast worker message for topic with no local handler is silently ignored', () => {
    // Covers `handlers.get(topic)?.forEach()` null branch in the worker message handler.
    const bus = createBus();
    const port = (bus as unknown as { worker: { port: { _receive(d: unknown): void } } }).worker.port;
    expect(() => {
      port._receive({ type: 'broadcast', topic: 'unregistered-topic', payload: 'x' });
    }).not.toThrow();
    bus.close();
  });

  it('worker broadcast message without topic field is ignored (`if (topic)` false branch)', () => {
    const bus = createBus();
    const port = (bus as unknown as { worker: { port: { _receive(d: unknown): void } } }).worker.port;
    expect(() => {
      port._receive({ type: 'broadcast', payload: 'x' }); // no topic
    }).not.toThrow();
    bus.close();
  });

  it('worker stream-end for unknown requestId is ignored (`if (stream)` false branch)', () => {
    const bus = createBus();
    const port = (bus as unknown as { worker: { port: { _receive(d: unknown): void } } }).worker.port;
    expect(() => {
      port._receive({ type: 'stream-end', requestId: 'no-such-stream' });
    }).not.toThrow();
    bus.close();
  });

  it('handler throwing a non-Error object converts it to string via String(obj) path', async () => {
    // Covers `(err as Error).message ?? err` branch where .message is undefined.
    const bus = createBus();
    bus.handle('throws-object', () => { throw { detail: 'custom err' }; });
    const err = await bus.request('throws-object', {}).catch(e => e);
    expect(err).toBeInstanceOf(NirnamRequestError);
    expect(err.code).toBe(NirnamErrorCode.HANDLER_REJECTED);
  });

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

// --- NirnamBus class export --------------------------------------------------

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

// --- NirnamRequestError ------------------------------------------------------

describe('NirnamRequestError', () => {
  it('is an instance of Error', () => {
    const e = new NirnamRequestError(NirnamErrorCode.TIMEOUT, 'test');
    expect(e).toBeInstanceOf(Error);
  });

  it('has the correct name', () => {
    const e = new NirnamRequestError(NirnamErrorCode.NO_HANDLER, 'test');
    expect(e.name).toBe('NirnamRequestError');
  });

  it('exposes the code on the instance', () => {
    const e = new NirnamRequestError(NirnamErrorCode.HANDLER_REJECTED, 'msg');
    expect(e.code).toBe(NirnamErrorCode.HANDLER_REJECTED);
  });

  it('all NirnamErrorCode values are defined', () => {
    expect(NirnamErrorCode.NO_HANDLER).toBe('NO_HANDLER');
    expect(NirnamErrorCode.HANDLER_REJECTED).toBe('HANDLER_REJECTED');
    expect(NirnamErrorCode.TIMEOUT).toBe('TIMEOUT');
    expect(NirnamErrorCode.STREAM_ABORTED).toBe('STREAM_ABORTED');
  });
});

// --- Agent Registration Protocol ---------------------------------------------

describe('register / discoverAgents / onAgentChange', () => {
  it('register() sends a register message to the worker', () => {
    const bus = createBus();
    const { worker } = internals(bus);

    bus.register({ agentId: 'calc-agent', capabilities: ['add'], metadata: { v: 1 } });

    expect(worker.port.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'register', agentId: 'calc-agent' })
    );
  });

  it('discoverAgents() returns empty array when no agents registered', async () => {
    const bus = createBus();
    const agents = await bus.discoverAgents();
    expect(agents).toEqual([]);
  });

  it('discoverAgents() returns registered agents', async () => {
    const busA = createBus();
    const busB = createBus();

    busA.register({ agentId: 'agent-1', capabilities: ['foo'] });
    busB.register({ agentId: 'agent-2', capabilities: ['bar'] });

    const agents = await busA.discoverAgents();

    expect(agents).toHaveLength(2);
    expect(agents.map(a => a.agentId)).toEqual(expect.arrayContaining(['agent-1', 'agent-2']));
  });

  it('discoverAgents() includes capabilities and metadata', async () => {
    const bus = createBus();
    bus.register({
      agentId: 'rich-agent',
      capabilities: ['read', 'write'],
      metadata: { model: 'claude-sonnet-4-6' },
    });

    const [agent] = await bus.discoverAgents();

    expect(agent.capabilities).toEqual(['read', 'write']);
    expect(agent.metadata).toEqual({ model: 'claude-sonnet-4-6' });
  });

  it('onAgentChange() fires with type:join when a new agent registers', async () => {
    const observer = createBus();
    const agent = createBus();
    const handler = jest.fn();

    observer.onAgentChange(handler);
    agent.register({ agentId: 'newcomer' });

    await Promise.resolve(); // allow microtasks

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'join', agent: expect.objectContaining({ agentId: 'newcomer' }) })
    );
  });

  it('onAgentChange() fires with type:leave when a registered agent closes', async () => {
    const observer = createBus();
    const agent = createBus();
    const handler = jest.fn();

    observer.onAgentChange(handler);
    agent.register({ agentId: 'leaver' });
    agent.close(); // triggers port.close() which cleans up the agent registry

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'leave', agentId: 'leaver' })
    );
  });

  it('onAgentChange() unsub stops future notifications', () => {
    const observer = createBus();
    const agent = createBus();
    const handler = jest.fn();

    const unsub = observer.onAgentChange(handler);
    unsub();
    agent.register({ agentId: 'silent' });

    expect(handler).not.toHaveBeenCalled();
  });

  it('sends watch-agents only once regardless of handler count', () => {
    const bus = createBus();
    const { worker } = internals(bus);

    bus.onAgentChange(() => {});
    bus.onAgentChange(() => {});
    bus.onAgentChange(() => {});

    const watchCalls = worker.port.postMessage.mock.calls.filter(
      (c: unknown[]) => (c[0] as { type: string }).type === 'watch-agents'
    );
    expect(watchCalls).toHaveLength(1);
  });

  it('registering the same agentId twice overwrites the previous entry', async () => {
    const bus = createBus();

    bus.register({ agentId: 'my-agent', capabilities: ['v1'] });
    bus.register({ agentId: 'my-agent', capabilities: ['v2'] });

    const agents = await bus.discoverAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0].capabilities).toEqual(['v2']);
  });

  it('agent without capabilities or metadata is still discoverable', async () => {
    const bus = createBus();
    bus.register({ agentId: 'bare-agent' });

    const [agent] = await bus.discoverAgents();
    expect(agent.agentId).toBe('bare-agent');
  });
});
