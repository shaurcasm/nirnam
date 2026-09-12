/**
 * Jest global test setup.
 *
 * Installs mocks for Worker, SharedWorker, MessageChannel, BroadcastChannel,
 * URL.createObjectURL and Blob so NirnamBus can run in a Node test
 * environment.
 *
 * The mocks are transport shims only: routing goes through the real
 * `MessageHub` from `src/hub.ts`, exactly as it does inside a worker. Delivery
 * is synchronous — a `postMessage` on one end of a mock channel invokes
 * `onmessage` on the other end before it returns — so most assertions need no
 * awaiting.
 */

import { MessageHub } from '../src/hub';
import type { HubPort } from '../src/hub';
import { disposeHubs } from '../src/hub-port';

// --- MockMessageChannel ------------------------------------------------------

export interface MockPort extends HubPort {
  postMessage: jest.Mock;
  start: jest.Mock;
  close: jest.Mock;
  addEventListener: jest.Mock;
  /** The other end of the channel. */
  peer: MockPort;
  /** Deliver a message to this port's own `onmessage`, as if the peer had posted it. */
  _receive(data: unknown, ports?: HubPort[]): void;
  /** Fire this port's 'close' listeners. */
  _emitClose(): void;
}

export class MockMessageChannel {
  port1: MockPort;
  port2: MockPort;

  constructor() {
    this.port1 = MockMessageChannel.makePort();
    this.port2 = MockMessageChannel.makePort();
    this.port1.peer = this.port2;
    this.port2.peer = this.port1;
  }

  private static makePort(): MockPort {
    // As in the spec, closing one end fires 'close' on the entangled end.
    const closeListeners: Array<() => void> = [];
    const port: MockPort = {
      onmessage: null,
      peer: undefined as unknown as MockPort,
      start: jest.fn(),
      addEventListener: jest.fn((type: string, listener: () => void) => {
        if (type === 'close') closeListeners.push(listener);
      }),
      postMessage: jest.fn((data: unknown, transfer: HubPort[] = []) => {
        port.peer._receive(data, transfer);
      }),
      close: jest.fn(() => port.peer._emitClose()),
      _receive(data: unknown, ports: HubPort[] = []) {
        port.onmessage?.({ data, ports } as unknown as MessageEvent);
      },
      _emitClose() {
        closeListeners.forEach(l => l());
      },
    };
    return port;
  }
}

// --- MockWorker (dedicated) --------------------------------------------------

let lastWorkerUrl: string | null = null;
const workerInstances: MockWorker[] = [];

/**
 * A dedicated worker running the real hub. The creator talks to it only by
 * transferring `MessagePort`s in `{ type: 'connect' }` messages — the same
 * protocol `src/worker-entry.ts` implements.
 */
export class MockWorker {
  readonly hub = new MessageHub();
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  terminate = jest.fn();
  postMessage = jest.fn((data: unknown, transfer: HubPort[] = []) => {
    const msg = data as { type?: string } | null;
    if (msg?.type === 'connect' && transfer[0]) this.hub.connect(transfer[0]);
  });

  constructor(public url: string) {
    lastWorkerUrl = url;
    workerInstances.push(this);
  }
}

// --- MockSharedWorker --------------------------------------------------------

const sharedHubs = new Map<string, MessageHub>();

/** A shared worker: one hub per URL, shared by every instance created for it. */
export class MockSharedWorker {
  port: MockPort;
  onerror: ((e: unknown) => void) | null = null;

  constructor(url: string) {
    lastWorkerUrl = url;
    let hub = sharedHubs.get(url);
    if (!hub) {
      hub = new MessageHub();
      sharedHubs.set(url, hub);
    }
    const channel = new MockMessageChannel();
    hub.connect(channel.port2);
    this.port = channel.port1;
  }
}

// --- Test helpers ------------------------------------------------------------

export function resetWorkerState() {
  disposeHubs();
  lastWorkerUrl = null;
  workerInstances.length = 0;
  sharedHubs.clear();
}

export function getLastWorkerUrl() {
  return lastWorkerUrl;
}

export function getWorkerInstances(): readonly MockWorker[] {
  return workerInstances;
}

// --- MockBroadcastChannel ----------------------------------------------------

export class MockBroadcastChannel {
  private static registry = new Map<string, MockBroadcastChannel[]>();

  onmessage: ((e: { data: unknown }) => void) | null = null;
  lastPostedData: unknown = null;
  private _name: string;

  constructor(name: string) {
    this._name = name;
    const list = MockBroadcastChannel.registry.get(name) ?? [];
    list.push(this);
    MockBroadcastChannel.registry.set(name, list);
  }

  postMessage(data: unknown) {
    this.lastPostedData = data;
    const others = (MockBroadcastChannel.registry.get(this._name) ?? []).filter(ch => ch !== this);
    others.forEach(ch => ch._simulateIncoming(data));
  }

  _simulateIncoming(data: unknown) {
    this.onmessage?.({ data });
  }

  close() {
    const list = MockBroadcastChannel.registry.get(this._name) ?? [];
    MockBroadcastChannel.registry.set(this._name, list.filter(ch => ch !== this));
  }

  static getInstances(name = 'nirnam-bus-v1'): MockBroadcastChannel[] {
    return MockBroadcastChannel.registry.get(name) ?? [];
  }

  static reset() {
    MockBroadcastChannel.registry = new Map();
  }
}

export function resetBroadcastChannels() {
  MockBroadcastChannel.reset();
}

// --- Install globals ---------------------------------------------------------

const g = global as unknown as Record<string, unknown>;

g.Worker = MockWorker;
g.SharedWorker = MockSharedWorker;
g.MessageChannel = MockMessageChannel;
g.BroadcastChannel = MockBroadcastChannel;

g.URL = {
  createObjectURL: jest.fn(() => 'blob:mock-url'),
  revokeObjectURL: jest.fn(),
};

g.Blob = class MockBlob {
  constructor(public parts: unknown[], public options?: unknown) {}
};
