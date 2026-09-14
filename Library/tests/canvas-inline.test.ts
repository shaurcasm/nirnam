/**
 * inlineWorker — a Worker-shaped object that runs an orchestrator on the
 * calling thread, over a MessageChannel, so the host side of the runtime
 * cannot tell the difference. Same protocol, same handshake, other thread.
 *
 * The MessageChannel here is the test setup's synchronous mock, so every
 * message lands before `postMessage` returns.
 */

import { inlineWorker } from '../src/canvas/inline';
import { createOrchestrator } from '../src/canvas/orchestrator';
import type { Orchestrator, OrchestratorClock, OrchestratorScope } from '../src/canvas/orchestrator';
import type { Surface, SurfaceSize, FrameInput, OrchestratorMessage } from '../src/canvas/types';
import { NIRNAM_CONNECT } from '../src/types';
import { connectWorkerBus } from '../src/worker';
import { createBus } from '../src/index';
import { resetWorkerState, resetBroadcastChannels } from './setup';

// --- Fakes -------------------------------------------------------------------

class FakeClock implements OrchestratorClock {
  time = 0;
  private next = 1;
  private pending = new Map<number, (t: number) => void>();
  now() {
    return this.time;
  }
  requestFrame(cb: (t: number) => void) {
    const id = this.next++;
    this.pending.set(id, cb);
    return id;
  }
  cancelFrame(id: number) {
    this.pending.delete(id);
  }
  tick(ms = 16) {
    this.time += ms;
    const due = [...this.pending.values()];
    this.pending.clear();
    due.forEach(cb => cb(this.time));
  }
  get scheduled() {
    return this.pending.size;
  }
}

interface RecordingSurface extends Surface<{ colour: string }> {
  attached: { canvas: OffscreenCanvas; size: SurfaceSize } | null;
  frames: Array<{ dt: number; input: FrameInput }>;
  states: Array<{ colour: string }>;
  detached: boolean;
}

function recordingSurface(): RecordingSurface {
  const s: RecordingSurface = {
    attached: null,
    frames: [],
    states: [],
    detached: false,
    attach(canvas, size) {
      s.attached = { canvas, size };
    },
    resize(size) {
      if (s.attached) s.attached.size = size;
    },
    frame(dt, input) {
      s.frames.push({ dt, input });
    },
    onState(state) {
      s.states.push(state);
    },
    detach() {
      s.detached = true;
    },
  };
  return s;
}

/** A canvas that structured-clones: data only, no methods. */
const fakeCanvas = () => ({ width: 0, height: 0 }) as unknown as OffscreenCanvas;
const size = (width = 300, height = 150, dpr = 1): SurfaceSize => ({ width, height, dpr });

let clock: FakeClock;
let surface: RecordingSurface;
let orchestrator: Orchestrator | null;
let scopes: OrchestratorScope[];

function setup(scope: OrchestratorScope) {
  scopes.push(scope);
  orchestrator = createOrchestrator({
    surfaces: { bg: () => surface },
    scope,
    clock,
    statsIntervalMs: 100,
  });
  return orchestrator;
}

beforeEach(() => {
  clock = new FakeClock();
  surface = recordingSurface();
  orchestrator = null;
  scopes = [];
  resetWorkerState();
  resetBroadcastChannels();
});

// --- Tests -------------------------------------------------------------------

describe('inlineWorker', () => {
  it('runs setup once with a scope, before anything is posted', () => {
    const worker = inlineWorker(setup);
    expect(scopes).toHaveLength(1);
    expect(orchestrator).not.toBeNull();
    worker.terminate();
  });

  it('delivers host messages to the orchestrator: attach, state, resize, detach', () => {
    const worker = inlineWorker(setup);
    const canvas = fakeCanvas();

    worker.postMessage({ type: 'canvas:attach', surfaceId: 'bg', canvas, size: size() });
    expect(surface.attached).not.toBeNull();
    // The canvas arrived by structured clone: same shape, sized by the orchestrator.
    expect(surface.attached!.canvas).toEqual(expect.objectContaining({ width: 300, height: 150 }));
    expect(surface.attached!.size).toEqual(size());

    worker.postMessage({ type: 'canvas:state', surfaceId: 'bg', state: { colour: 'red' } });
    expect(surface.states).toEqual([{ colour: 'red' }]);

    worker.postMessage({ type: 'canvas:resize', surfaceId: 'bg', size: size(400, 200, 2) });
    expect(surface.attached!.canvas).toEqual(expect.objectContaining({ width: 800, height: 400 }));
    expect(surface.attached!.size).toEqual(size(400, 200, 2));

    worker.postMessage({ type: 'canvas:detach', surfaceId: 'bg' });
    expect(surface.detached).toBe(true);
    worker.terminate();
  });

  it('frames run on the injected clock once a surface is attached', () => {
    const worker = inlineWorker(setup);
    worker.postMessage({ type: 'canvas:attach', surfaceId: 'bg', canvas: fakeCanvas(), size: size() });
    expect(clock.scheduled).toBe(1);
    clock.tick();
    clock.tick();
    expect(surface.frames.length).toBeGreaterThanOrEqual(1);
    worker.terminate();
  });

  it('relays what the orchestrator posts — stats and tier changes — to message listeners', () => {
    const worker = inlineWorker(setup);
    const received: OrchestratorMessage[] = [];
    const listener = (event: MessageEvent) => received.push(event.data as OrchestratorMessage);
    worker.addEventListener('message', listener);

    worker.postMessage({ type: 'canvas:attach', surfaceId: 'bg', canvas: fakeCanvas(), size: size() });
    clock.tick(16);
    clock.tick(100);
    expect(received.some(m => m.type === 'canvas:stats')).toBe(true);

    worker.removeEventListener('message', listener);
    const before = received.length;
    clock.tick(100);
    clock.tick(100);
    expect(received.length).toBe(before);
    worker.terminate();
  });

  it('supports several listeners at once and removes only the one asked', () => {
    const worker = inlineWorker(setup);
    const a = jest.fn();
    const b = jest.fn();
    worker.addEventListener('message', a);
    worker.addEventListener('message', b);
    worker.postMessage({ type: 'canvas:attach', surfaceId: 'bg', canvas: fakeCanvas(), size: size() });
    clock.tick(16);
    clock.tick(100);
    expect(a).toHaveBeenCalled();
    expect(b).toHaveBeenCalled();
    worker.removeEventListener('message', a);
    a.mockClear();
    b.mockClear();
    clock.tick(100);
    clock.tick(100);
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalled();
    worker.terminate();
  });

  it('terminate disposes the orchestrator, stops the loop and drops both ends', () => {
    const worker = inlineWorker(setup);
    const listener = jest.fn();
    worker.addEventListener('message', listener);
    worker.postMessage({ type: 'canvas:attach', surfaceId: 'bg', canvas: fakeCanvas(), size: size() });
    expect(clock.scheduled).toBe(1);

    worker.terminate();
    expect(surface.detached).toBe(true);
    expect(clock.scheduled).toBe(0);
    expect(orchestrator!.running).toBe(false);

    // Nothing gets through after: not in, not out.
    worker.postMessage({ type: 'canvas:state', surfaceId: 'bg', state: { colour: 'blue' } });
    expect(surface.states).toEqual([]);
    clock.tick(100);
    expect(listener).not.toHaveBeenCalled();
  });

  it('terminate is idempotent and tolerates a setup that returned nothing', () => {
    const worker = inlineWorker(() => {});
    expect(() => {
      worker.terminate();
      worker.terminate();
    }).not.toThrow();
  });

  it('forwards a transferred port with the connect message, so the inline worker joins the bus like a real one', async () => {
    const bus = createBus();
    let joined: Promise<unknown> | null = null;
    const worker = inlineWorker(scope => {
      joined = connectWorkerBus({ scope });
      return setup(scope);
    });

    const adoption = bus.adoptWorker(worker);
    const workerBus = (await joined!) as ReturnType<typeof createBus>;
    expect(workerBus.hub).toBe('port');

    const heard: unknown[] = [];
    bus.subscribe('bench:stats', payload => heard.push(payload));
    workerBus.publish('bench:stats', { frames: 60 });
    expect(heard).toEqual([{ frames: 60 }]);

    adoption.release();
    worker.terminate();
    bus.close();
  });

  it('leaves messages that are not for the orchestrator to other scope listeners', () => {
    const other = jest.fn();
    const worker = inlineWorker(scope => {
      scope.addEventListener('message', other);
      return setup(scope);
    });
    worker.postMessage({ type: NIRNAM_CONNECT });
    expect(other).toHaveBeenCalledTimes(1);
    expect(surface.attached).toBeNull();
    worker.terminate();
  });
});
