/**
 * Hub selection, fallback, worker lifetime and port adoption.
 *
 * What differs between the hub kinds lives here; what they share is covered
 * by bus.test.ts, which runs the whole bus suite once per kind.
 */

jest.mock('../src/worker-source', () => ({ default: '/* mock worker script */' }));

import { createBus } from '../src/bus';
import { resolveHubKind, disposeHubs } from '../src/hub-port';
import {
  resetWorkerState,
  resetBroadcastChannels,
  getLastWorkerUrl,
  getWorkerInstances,
  MockMessageChannel,
  MockWorker,
  MockSharedWorker,
} from './setup';

const g = global as unknown as Record<string, unknown>;

beforeEach(() => {
  resetWorkerState();
  resetBroadcastChannels();
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  g.Worker = MockWorker;
  g.SharedWorker = MockSharedWorker;
  g.MessageChannel = MockMessageChannel;
  jest.restoreAllMocks();
});

// --- resolveHubKind ----------------------------------------------------------

describe('resolveHubKind', () => {
  it('defaults to dedicated', () => {
    expect(resolveHubKind()).toBe('dedicated');
    expect(createBus().hub).toBe('dedicated');
  });

  it('honours an explicit kind when the environment supports it', () => {
    expect(resolveHubKind('shared')).toBe('shared');
    expect(resolveHubKind('inline')).toBe('inline');
    expect(createBus({ hub: 'shared' }).hub).toBe('shared');
    expect(createBus({ hub: 'inline' }).hub).toBe('inline');
  });

  it('falls back from shared to dedicated where SharedWorker is missing, warning once', () => {
    delete g.SharedWorker;

    expect(resolveHubKind('shared')).toBe('dedicated');
    expect(createBus({ hub: 'shared' }).hub).toBe('dedicated');
    expect(getWorkerInstances()).toHaveLength(1);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('SharedWorker is not available'));
  });

  it('falls back from dedicated to inline where Worker is missing', () => {
    delete g.Worker;

    expect(resolveHubKind('dedicated')).toBe('inline');
    expect(createBus().hub).toBe('inline');
    expect(getLastWorkerUrl()).toBeNull();
  });

  it('falls back from dedicated to inline where MessageChannel is missing', () => {
    delete g.MessageChannel;
    expect(resolveHubKind('dedicated')).toBe('inline');
  });

  it('falls all the way from shared to inline in a worker-less environment', () => {
    delete g.SharedWorker;
    delete g.Worker;
    expect(resolveHubKind('shared')).toBe('inline');
  });
});

// --- worker URL --------------------------------------------------------------

describe('worker script URL', () => {
  afterEach(() => {
    delete g.__NIRNAM_STATIC_WORKER_URL__;
  });

  it.each(['dedicated', 'shared'] as const)('%s: uses a Blob URL by default', (hub) => {
    createBus({ hub });
    expect(getLastWorkerUrl()).toBe('blob:mock-url');
  });

  it.each(['dedicated', 'shared'] as const)('%s: uses the injected static URL when present', (hub) => {
    g.__NIRNAM_STATIC_WORKER_URL__ = '/nirnam-worker.js';
    createBus({ hub });
    expect(getLastWorkerUrl()).toBe('/nirnam-worker.js');
  });

  it.each(['dedicated', 'shared'] as const)('%s: an explicit workerUrl wins over the injected one', (hub) => {
    g.__NIRNAM_STATIC_WORKER_URL__ = '/nirnam-worker.js';
    createBus({ hub, workerUrl: '/override.js' });
    expect(getLastWorkerUrl()).toBe('/override.js');
  });
});

// --- dedicated worker lifetime -----------------------------------------------

describe('dedicated worker lifetime', () => {
  it('two buses on the page share one worker and reach each other', () => {
    const a = createBus();
    const b = createBus();
    expect(getWorkerInstances()).toHaveLength(1);

    const handler = jest.fn();
    a.subscribe('t', handler);
    b.publish('t', 'x');
    expect(handler).toHaveBeenCalledWith('x');
  });

  it('terminates the worker only when the last bus closes', () => {
    const a = createBus();
    const b = createBus();
    const [worker] = getWorkerInstances();

    a.close();
    expect(worker.terminate).not.toHaveBeenCalled();

    b.close();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('starts a fresh worker after the last bus closed', () => {
    createBus().close();
    createBus();
    expect(getWorkerInstances()).toHaveLength(2);
  });

  it('a different script URL gets its own worker', () => {
    createBus();
    createBus({ workerUrl: '/other.js' });
    expect(getWorkerInstances().map(w => w.url)).toEqual(['blob:mock-url', '/other.js']);
  });

  it('disposeHubs terminates every worker', () => {
    createBus();
    createBus({ workerUrl: '/other.js' });
    disposeHubs();
    getWorkerInstances().forEach(w => expect(w.terminate).toHaveBeenCalledTimes(1));
  });
});

// --- adoptPort ---------------------------------------------------------------

describe.each(['inline', 'dedicated', 'shared'] as const)('adoptPort on %s', (hub) => {
  it('makes the holder of the other end a full participant', () => {
    const bus = createBus({ hub });
    const { port1, port2 } = new MockMessageChannel();
    bus.adoptPort(port2 as unknown as MessagePort);

    // The "worker" side: speaks the wire protocol directly over its port.
    const received: unknown[] = [];
    port1.onmessage = (e) => received.push(e.data);
    port1.postMessage({ type: 'subscribe', topic: 't' });

    bus.publish('t', 'hello');
    expect(received).toContainEqual(expect.objectContaining({ type: 'broadcast', topic: 't', payload: 'hello' }));

    // And the other way: the participant answers a request from the bus.
    port1.onmessage = (e) => {
      const msg = e.data as { type: string; requestId: string; payload: unknown };
      if (msg.type === 'request') port1.postMessage({ type: 'response', requestId: msg.requestId, payload: 'pong' });
    };
    return expect(bus.request('t', 'ping')).resolves.toBe('pong');
  });

  it('transfers the port rather than cloning it', () => {
    const bus = createBus({ hub });
    const { port2 } = new MockMessageChannel();
    const spy = jest.spyOn((bus as unknown as { port: { postMessage: jest.Mock } }).port, 'postMessage');

    bus.adoptPort(port2 as unknown as MessagePort);

    expect(spy).toHaveBeenCalledWith({ type: 'connect' }, [port2]);
  });
});
