jest.mock('../src/worker-source', () => ({ default: '/* mock worker script */' }));

import { DataEvent } from '../src/data-event';
import { RequestType } from '../src/types';
import { createBus } from '../src/bus';
import { resetWorkerState, resetBroadcastChannels } from './setup';

// --- Mock CustomEvent and window for Node test environment -------------------

class MockCustomEvent<T = unknown> {
  readonly type: string;
  readonly detail: T;
  readonly bubbles: boolean;
  readonly cancelable: boolean;

  constructor(type: string, init?: { detail?: T; bubbles?: boolean; cancelable?: boolean }) {
    this.type = type;
    this.detail = init?.detail as T;
    this.bubbles = init?.bubbles ?? false;
    this.cancelable = init?.cancelable ?? false;
  }
}

const dispatchedEvents: MockCustomEvent<unknown>[] = [];
const mockDispatchEvent = jest.fn((event: MockCustomEvent<unknown>) => {
  dispatchedEvents.push(event);
});

beforeAll(() => {
  (global as Record<string, unknown>).CustomEvent = MockCustomEvent;
  (global as Record<string, unknown>).window = { dispatchEvent: mockDispatchEvent };
});

afterAll(() => {
  delete (global as Record<string, unknown>).window;
  delete (global as Record<string, unknown>).CustomEvent;
});

beforeEach(() => {
  resetWorkerState();
  resetBroadcastChannels();
  dispatchedEvents.length = 0;
  mockDispatchEvent.mockClear();
});

// --- DataEvent class ---------------------------------------------------------

describe('DataEvent', () => {
  it('sets event type to `${requestType}_${topic}`', () => {
    const event = new DataEvent(RequestType.BROAD, 'counter', 42);
    expect(event.type).toBe('broad_counter');
  });

  it('stores detail, topic, and requestType', () => {
    const payload = { value: 99 };
    const event = new DataEvent(RequestType.BROAD, 'my-topic', payload);
    expect(event.detail).toBe(payload);
    expect(event.topic).toBe('my-topic');
    expect(event.requestType).toBe(RequestType.BROAD);
  });

  it('is not bubbling or cancelable', () => {
    const event = new DataEvent(RequestType.BROAD, 'counter', 0);
    expect(event.bubbles).toBe(false);
    expect(event.cancelable).toBe(false);
  });

  it('works with NARROW request type', () => {
    const event = new DataEvent(RequestType.NARROW, 'query', 'hello');
    expect(event.type).toBe('narrow_query');
    expect(event.detail).toBe('hello');
  });
});

// --- bus.publish() with dispatchDOMEvents ------------------------------------

describe('NirnamBus dispatchDOMEvents option', () => {
  it('does NOT dispatch DOM events by default', () => {
    const bus = createBus();
    bus.publish('counter', 42);
    expect(mockDispatchEvent).not.toHaveBeenCalled();
    bus.close();
  });

  it('dispatches a DataEvent on window when dispatchDOMEvents is true', () => {
    const bus = createBus({ dispatchDOMEvents: true });
    bus.publish('counter', 42);

    expect(mockDispatchEvent).toHaveBeenCalledTimes(1);
    const event = mockDispatchEvent.mock.calls[0][0] as DataEvent<number>;
    expect(event.type).toBe('broad_counter');
    expect(event.detail).toBe(42);
    bus.close();
  });

  it('dispatches one event per publish call', () => {
    const bus = createBus({ dispatchDOMEvents: true });
    bus.publish('counter', 1);
    bus.publish('counter', 2);
    bus.publish('status', 'ok');

    expect(mockDispatchEvent).toHaveBeenCalledTimes(3);
    expect((mockDispatchEvent.mock.calls[0][0] as DataEvent<number>).type).toBe('broad_counter');
    expect((mockDispatchEvent.mock.calls[1][0] as DataEvent<number>).detail).toBe(2);
    expect((mockDispatchEvent.mock.calls[2][0] as DataEvent<string>).type).toBe('broad_status');
    bus.close();
  });

  it('includes topic and requestType on the dispatched DataEvent', () => {
    const bus = createBus({ dispatchDOMEvents: true });
    bus.publish('my-topic', { x: 1 });

    const event = mockDispatchEvent.mock.calls[0][0] as DataEvent<{ x: number }>;
    expect(event.topic).toBe('my-topic');
    expect(event.requestType).toBe(RequestType.BROAD);
    bus.close();
  });
});
