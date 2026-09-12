/**
 * @palinc/nirnam/worker — a bus for code that lives in a dedicated worker.
 *
 * The worker cannot create a hub connection; it is handed one end of a
 * MessageChannel whose other end the main-thread bus has adopted. From there
 * it is a full participant. These tests pair a main-thread bus on the inline
 * hub with a worker bus over a mock channel and check every pattern in both
 * directions, plus the two handshake helpers.
 */

jest.mock('../src/worker-source', () => ({ default: '/* mock worker script */' }));

import { createBus, NirnamBus } from '../src/bus';
import { createWorkerBus, connectWorkerBus, NIRNAM_CONNECT } from '../src/worker';
import { resetWorkerState, resetBroadcastChannels, MockMessageChannel } from './setup';

const flushPromises = () => Promise.resolve().then(() => Promise.resolve());

let main: NirnamBus;
let worker: NirnamBus;

beforeEach(() => {
  resetWorkerState();
  resetBroadcastChannels();
  main = createBus({ hub: 'inline' });
  const { port1, port2 } = new MockMessageChannel();
  main.adoptPort(port2 as unknown as MessagePort);
  worker = createWorkerBus(port1 as unknown as MessagePort);
});

afterEach(() => {
  worker.close();
  main.close();
});

describe('createWorkerBus', () => {
  it('reports that it is connected over a given port', () => {
    expect(worker.hub).toBe('port');
    expect(worker).toBeInstanceOf(NirnamBus);
  });

  it('never opens a BroadcastChannel — the hub is its whole world', () => {
    expect((worker as unknown as { channel: unknown }).channel).toBeNull();
  });

  it('delivers publishes from main to the worker', () => {
    const handler = jest.fn();
    worker.subscribe('t', handler);
    main.publish('t', 'to-worker');
    expect(handler).toHaveBeenCalledWith('to-worker');
  });

  it('delivers publishes from the worker to main', () => {
    const handler = jest.fn();
    main.subscribe('t', handler);
    worker.publish('t', 'to-main');
    expect(handler).toHaveBeenCalledWith('to-main');
  });

  it('answers requests from main', async () => {
    worker.handle<number, number>('double', n => n * 2);
    await expect(main.request('double', 21)).resolves.toBe(42);
  });

  it('makes requests to main', async () => {
    main.handle<string, string>('upper', s => s.toUpperCase());
    await expect(worker.request('upper', 'hi')).resolves.toBe('HI');
  });

  it('streams from the worker to main', async () => {
    worker.handleStream<number, number>('count', async function* (n) {
      for (let i = 1; i <= n; i++) yield i;
    });
    const received: number[] = [];
    for await (const chunk of main.requestStream<number, number>('count', 3)) received.push(chunk);
    expect(received).toEqual([1, 2, 3]);
  });

  it('registers as an agent that main can discover', async () => {
    worker.register({ agentId: 'render', capabilities: ['draw'] });
    const agents = await main.discoverAgents();
    expect(agents).toEqual([{ agentId: 'render', capabilities: ['draw'], metadata: undefined }]);
  });

  it('leaves the hub on close', async () => {
    const handler = jest.fn();
    worker.subscribe('t', handler);
    worker.close();
    main.publish('t', 'after');
    await flushPromises();
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('adoptWorker / connectWorkerBus handshake', () => {
  it('adoptWorker hands the worker one end of a fresh channel', () => {
    const fakeWorker = { postMessage: jest.fn() };
    const spy = jest.spyOn((main as unknown as { port: { postMessage: jest.Mock } }).port, 'postMessage');

    main.adoptWorker(fakeWorker as unknown as Worker);

    const [[message, transfer]] = fakeWorker.postMessage.mock.calls as [[unknown, MockMessageChannel['port2'][]]];
    expect(message).toEqual({ type: NIRNAM_CONNECT });
    expect(transfer).toHaveLength(1);
    // The hub got the other end of the same channel.
    expect(spy).toHaveBeenCalledWith({ type: 'connect' }, [transfer[0].peer]);
  });

  it('connectWorkerBus resolves with a bus once the connect message arrives', async () => {
    const listeners = new Set<(event: MessageEvent) => void>();
    const scope = {
      addEventListener: jest.fn((_type: string, l: (event: MessageEvent) => void) => listeners.add(l)),
      removeEventListener: jest.fn((_type: string, l: (event: MessageEvent) => void) => listeners.delete(l)),
    };

    const pending = connectWorkerBus({ scope });
    const { port1, port2 } = new MockMessageChannel();
    main.adoptPort(port2 as unknown as MessagePort);

    listeners.forEach(l => l({ data: { type: 'unrelated' }, ports: [] } as unknown as MessageEvent));
    listeners.forEach(l => l({ data: { type: NIRNAM_CONNECT }, ports: [port1] } as unknown as MessageEvent));

    const bus = await pending;
    expect(bus.hub).toBe('port');
    expect(scope.removeEventListener).toHaveBeenCalledTimes(1);

    const handler = jest.fn();
    main.subscribe('t', handler);
    bus.publish('t', 'from-worker');
    expect(handler).toHaveBeenCalledWith('from-worker');
    bus.close();
  });

  it('connectWorkerBus ignores a connect message with no port', async () => {
    const listeners = new Set<(event: MessageEvent) => void>();
    const scope = {
      addEventListener: jest.fn((_type: string, l: (event: MessageEvent) => void) => listeners.add(l)),
      removeEventListener: jest.fn(),
    };
    let resolved = false;
    connectWorkerBus({ scope }).then(() => { resolved = true; });

    listeners.forEach(l => l({ data: { type: NIRNAM_CONNECT }, ports: [] } as unknown as MessageEvent));
    await flushPromises();

    expect(resolved).toBe(false);
  });
});
