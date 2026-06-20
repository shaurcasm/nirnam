/**
 * Jest global test setup.
 *
 * Installs mocks for SharedWorker, BroadcastChannel, URL.createObjectURL,
 * and Blob so the NirnamBus can run in a Node test environment.
 *
 * Message delivery direction convention:
 *   port -> worker : NirnamBus calls port.postMessage() -- handled by MockPort.postMessage
 *   worker -> port : MockMessageBus calls port._receive() -- triggers port.onmessage
 */

// --- Mock MessageBus (mirrors worker-source.ts logic) -----------------------

interface IMockPort {
  onmessage: ((e: { data: unknown }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  postMessage: jest.Mock;
  start: jest.Mock;
  close: jest.Mock;
  _receive(data: unknown): void;
}

class MockMessageBus {
  topicSubscribers = new Map<string, Set<IMockPort>>();
  pendingRequests = new Map<string, IMockPort>();
  rrCounters = new Map<string, number>();

  subscribe(topic: string, port: IMockPort) {
    const subs = this.topicSubscribers.get(topic) ?? new Set<IMockPort>();
    subs.add(port);
    this.topicSubscribers.set(topic, subs);
  }

  unsubscribe(topic: string, port: IMockPort) {
    const subs = this.topicSubscribers.get(topic);
    if (!subs) return;
    subs.delete(port);
    if (subs.size === 0) {
      this.topicSubscribers.delete(topic);
      this.rrCounters.delete(topic);
    }
  }

  broadcast(topic: string, payload: unknown, sourcePageId: string) {
    this.topicSubscribers.get(topic)?.forEach(port =>
      port._receive({ type: 'broadcast', topic, payload, sourcePageId })
    );
  }

  _pickHandler(topic: string): IMockPort | null {
    const subs = this.topicSubscribers.get(topic);
    if (!subs || subs.size === 0) return null;
    const arr = [...subs];
    const idx = (this.rrCounters.get(topic) ?? 0) % arr.length;
    this.rrCounters.set(topic, idx + 1);
    return arr[idx];
  }

  request(topic: string, payload: unknown, requestId: string, originPort: IMockPort, msgType = 'request') {
    const handler = this._pickHandler(topic);
    if (!handler) {
      originPort._receive({
        type: 'error',
        topic,
        requestId,
        error: `No handler registered for topic "${topic}"`,
        code: 'NO_HANDLER',
      });
      return;
    }
    this.pendingRequests.set(requestId, originPort);
    handler._receive({ type: msgType, topic, payload, requestId });
  }

  response(requestId: string, payload: unknown, respondingPort: IMockPort) {
    const originPort = this.pendingRequests.get(requestId);
    if (!originPort) {
      respondingPort._receive({
        type: 'error',
        requestId,
        error: `No pending request for id "${requestId}"`,
        code: 'HANDLER_REJECTED',
      });
      return;
    }
    this.pendingRequests.delete(requestId);
    originPort._receive({ type: 'response', requestId, payload });
  }

  streamChunk(requestId: string, payload: unknown) {
    const originPort = this.pendingRequests.get(requestId);
    if (originPort) {
      originPort._receive({ type: 'stream-chunk', requestId, payload });
    }
  }

  streamEnd(requestId: string) {
    const originPort = this.pendingRequests.get(requestId);
    if (originPort) {
      originPort._receive({ type: 'stream-end', requestId });
      this.pendingRequests.delete(requestId);
    }
  }
}

// --- Mutable singleton -- reset between tests --------------------------------

let currentMockBus = new MockMessageBus();
let lastSharedWorkerUrl: string | null = null;

export function resetWorkerState() {
  currentMockBus = new MockMessageBus();
  lastSharedWorkerUrl = null;
}

export function getLastSharedWorkerUrl() {
  return lastSharedWorkerUrl;
}

// --- MockPort ----------------------------------------------------------------

function createMockPort(): IMockPort {
  const port: IMockPort = {
    onmessage: null,
    onerror: null,
    postMessage: jest.fn((data: Record<string, unknown>) => {
      // Port -> Worker: route through the current mock bus
      const { type, topic, payload, requestId, sourcePageId } = data;
      switch (type) {
        case 'subscribe':
          currentMockBus.subscribe(topic as string, port);
          break;
        case 'unsubscribe':
          currentMockBus.unsubscribe(topic as string, port);
          break;
        case 'broadcast':
          currentMockBus.broadcast(topic as string, payload, sourcePageId as string);
          break;
        case 'request':
          currentMockBus.request(topic as string, payload, requestId as string, port, 'request');
          break;
        case 'request-stream':
          currentMockBus.request(topic as string, payload, requestId as string, port, 'request-stream');
          break;
        case 'response':
          currentMockBus.response(requestId as string, payload, port);
          break;
        case 'stream-chunk':
          currentMockBus.streamChunk(requestId as string, payload);
          break;
        case 'stream-end':
          currentMockBus.streamEnd(requestId as string);
          break;
        case 'error': {
          // Handler bus sends error back to worker; route it to the origin port.
          const originPort = currentMockBus.pendingRequests.get(requestId as string);
          if (originPort) {
            currentMockBus.pendingRequests.delete(requestId as string);
            originPort._receive({ type: 'error', requestId, error: data.error, code: data.code });
          }
          break;
        }
      }
    }),
    start: jest.fn(),
    close: jest.fn(),
    _receive(data: unknown) {
      // Worker -> Port: deliver by calling onmessage
      this.onmessage?.({ data });
    },
  };
  return port;
}

// --- MockSharedWorker --------------------------------------------------------

class MockSharedWorker {
  port: IMockPort;
  onerror: ((e: unknown) => void) | null = null;
  constructor(url: string) {
    lastSharedWorkerUrl = url;
    this.port = createMockPort();
  }
}

// --- MockBroadcastChannel ----------------------------------------------------

export class MockBroadcastChannel {
  private static registry = new Map<string, MockBroadcastChannel[]>();

  onmessage: ((e: { data: unknown }) => void) | null = null;
  /** Last data passed to postMessage -- useful for dedup assertions. */
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
    const others = (MockBroadcastChannel.registry.get(this._name) ?? []).filter(
      ch => ch !== this
    );
    others.forEach(ch => ch._simulateIncoming(data));
  }

  /** Directly deliver a message as if it arrived from another tab. */
  _simulateIncoming(data: unknown) {
    this.onmessage?.({ data });
  }

  close() {
    const list = MockBroadcastChannel.registry.get(this._name) ?? [];
    MockBroadcastChannel.registry.set(
      this._name,
      list.filter(ch => ch !== this)
    );
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

(global as unknown as Record<string, unknown>).SharedWorker = MockSharedWorker;
(global as unknown as Record<string, unknown>).BroadcastChannel = MockBroadcastChannel;

(global as unknown as Record<string, unknown>).URL = {
  createObjectURL: jest.fn(() => 'blob:mock-url'),
  revokeObjectURL: jest.fn(),
};

(global as unknown as Record<string, unknown>).Blob = class MockBlob {
  constructor(public parts: unknown[], public options?: unknown) {}
};
