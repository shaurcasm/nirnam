/**
 * CanvasHostController — the main-thread half of the canvas runtime.
 *
 * Transfers canvases to the worker and forwards size, visibility and pointer
 * input; relays stats and tier changes back. Every DOM dependency is
 * injected, so this runs in Node with fakes.
 */

import { CanvasHostController } from '../src/canvas/host';
import type { HostDeps } from '../src/canvas/host';
import type { HostMessage, OrchestratorMessage } from '../src/canvas/types';

// --- Fakes -------------------------------------------------------------------

type Listener = (event: unknown) => void;

class FakeTarget {
  listeners = new Map<string, Set<Listener>>();
  addEventListener = jest.fn((type: string, l: Listener) => {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(l);
  });
  removeEventListener = jest.fn((type: string, l: Listener) => {
    this.listeners.get(type)?.delete(l);
  });
  emit(type: string, event: unknown) {
    this.listeners.get(type)?.forEach(l => l(event));
  }
  count(type: string) {
    return this.listeners.get(type)?.size ?? 0;
  }
}

interface FakeCanvas {
  rect: { left: number; top: number; width: number; height: number };
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
  transferred: number;
}

function fakeCanvas(rect = { left: 100, top: 50, width: 300, height: 150 }): FakeCanvas {
  const c: FakeCanvas = {
    rect,
    transferred: 0,
    getBoundingClientRect: () => c.rect,
  };
  return c;
}

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  observed: unknown[] = [];
  disconnected = false;
  constructor(public callback: (entries: Array<{ target: unknown; contentRect: { width: number; height: number } }>) => void) {
    FakeResizeObserver.instances.push(this);
  }
  observe(el: unknown) {
    this.observed.push(el);
  }
  disconnect() {
    this.disconnected = true;
  }
  fire(target: unknown, width: number, height: number) {
    this.callback([{ target, contentRect: { width, height } }]);
  }
}

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  observed: unknown[] = [];
  disconnected = false;
  constructor(public callback: (entries: Array<{ target: unknown; isIntersecting: boolean }>) => void) {
    FakeIntersectionObserver.instances.push(this);
  }
  observe(el: unknown) {
    this.observed.push(el);
  }
  disconnect() {
    this.disconnected = true;
  }
  fire(target: unknown, isIntersecting: boolean) {
    this.callback([{ target, isIntersecting }]);
  }
}

let posted: Array<{ message: HostMessage; transfer: Transferable[] | undefined }>;
let workerListeners: Set<(m: OrchestratorMessage) => void>;
let pointerTarget: FakeTarget;
let frames: Array<() => void>;
let deferred: Array<() => void>;
let dpr: number;
let dprListeners: Array<() => void>;

function deps(): HostDeps {
  return {
    post: (message, transfer) => posted.push({ message, transfer }),
    onMessage: (listener) => {
      workerListeners.add(listener);
      return () => workerListeners.delete(listener);
    },
    transfer: (canvas) => {
      (canvas as unknown as FakeCanvas).transferred += 1;
      return { width: 0, height: 0 } as OffscreenCanvas;
    },
    ResizeObserver: FakeResizeObserver as unknown as typeof ResizeObserver,
    IntersectionObserver: FakeIntersectionObserver as unknown as typeof IntersectionObserver,
    pointerTarget: pointerTarget as unknown as EventTarget,
    devicePixelRatio: () => dpr,
    watchDevicePixelRatio: (cb) => {
      dprListeners.push(cb);
      return () => { dprListeners = dprListeners.filter(l => l !== cb); };
    },
    requestFrame: (cb) => { frames.push(cb); return frames.length; },
    cancelFrame: () => { frames.length = 0; },
    defer: (cb) => { deferred.push(cb); },
    now: () => 1234,
  };
}

function messagesOfType<T extends HostMessage['type']>(type: T) {
  return posted.filter(p => p.message.type === type).map(p => p.message as Extract<HostMessage, { type: T }>);
}

const flushFrames = () => { const due = frames.splice(0); due.forEach(cb => cb()); };
const flushDeferred = () => { const due = deferred.splice(0); due.forEach(cb => cb()); };

let host: CanvasHostController;

beforeEach(() => {
  posted = [];
  workerListeners = new Set();
  pointerTarget = new FakeTarget();
  frames = [];
  deferred = [];
  dpr = 2;
  dprListeners = [];
  FakeResizeObserver.instances = [];
  FakeIntersectionObserver.instances = [];
  host = new CanvasHostController(deps(), { tier: 'full' });
});

afterEach(() => host.dispose());

// --- attach ------------------------------------------------------------------

describe('attach', () => {
  it('transfers the canvas and sends it with its size and the current DPR', () => {
    const canvas = fakeCanvas();
    host.attach('tree', canvas as unknown as HTMLCanvasElement);

    expect(canvas.transferred).toBe(1);
    const [attach] = messagesOfType('canvas:attach');
    expect(attach).toMatchObject({ surfaceId: 'tree', size: { width: 300, height: 150, dpr: 2 } });
    expect(posted.find(p => p.message === attach)?.transfer).toEqual([attach.canvas]);
  });

  it('sends the tier first so the orchestrator never runs a frame at the wrong one', () => {
    host.attach('tree', fakeCanvas() as unknown as HTMLCanvasElement);
    expect(posted.map(p => p.message.type)).toEqual(['canvas:tier', 'canvas:attach']);
  });

  it('sends initial state after attaching, and again on setState', () => {
    const handle = host.attach('tree', fakeCanvas() as unknown as HTMLCanvasElement, { anchor: 'login' });
    handle.setState({ anchor: 'home' });

    expect(messagesOfType('canvas:state').map(m => m.state)).toEqual([{ anchor: 'login' }, { anchor: 'home' }]);
  });

  it('observes size and visibility of the canvas', () => {
    const canvas = fakeCanvas();
    host.attach('tree', canvas as unknown as HTMLCanvasElement);

    expect(FakeResizeObserver.instances[0].observed).toEqual([canvas]);
    expect(FakeIntersectionObserver.instances[0].observed).toEqual([canvas]);
  });

  it('never transfers the same element twice: re-attaching an element cancels its pending detach', () => {
    const canvas = fakeCanvas() as unknown as HTMLCanvasElement;
    const first = host.attach('tree', canvas, { a: 1 });
    first.detach();
    const second = host.attach('tree', canvas, { a: 2 });
    flushDeferred();

    expect((canvas as unknown as FakeCanvas).transferred).toBe(1);
    expect(messagesOfType('canvas:detach')).toHaveLength(0);
    expect(messagesOfType('canvas:attach')).toHaveLength(1);
    expect(messagesOfType('canvas:state').map(m => m.state)).toEqual([{ a: 1 }, { a: 2 }]);
    expect(second).not.toBe(first);
  });

  it('works without observers, sampling the size once', () => {
    host.dispose();
    host = new CanvasHostController({ ...deps(), ResizeObserver: undefined, IntersectionObserver: undefined }, { tier: 'full' });
    host.attach('tree', fakeCanvas() as unknown as HTMLCanvasElement);
    expect(messagesOfType('canvas:attach')[0].size).toEqual({ width: 300, height: 150, dpr: 2 });
  });
});

// --- detach ------------------------------------------------------------------

describe('detach', () => {
  it('is deferred, then tells the orchestrator and stops observing', () => {
    const handle = host.attach('tree', fakeCanvas() as unknown as HTMLCanvasElement);
    handle.detach();
    expect(messagesOfType('canvas:detach')).toHaveLength(0);

    flushDeferred();
    expect(messagesOfType('canvas:detach')).toEqual([{ type: 'canvas:detach', surfaceId: 'tree' }]);
    expect(FakeResizeObserver.instances[0].disconnected).toBe(true);
    expect(FakeIntersectionObserver.instances[0].disconnected).toBe(true);
  });

  it('is idempotent', () => {
    const handle = host.attach('tree', fakeCanvas() as unknown as HTMLCanvasElement);
    handle.detach();
    handle.detach();
    flushDeferred();
    expect(messagesOfType('canvas:detach')).toHaveLength(1);
  });

  it('ignores setState after detach', () => {
    const handle = host.attach('tree', fakeCanvas() as unknown as HTMLCanvasElement);
    handle.detach();
    flushDeferred();
    handle.setState({ late: true });
    expect(messagesOfType('canvas:state')).toHaveLength(0);
  });
});

// --- size and visibility -----------------------------------------------------

describe('size and visibility', () => {
  it('forwards resizes with the current DPR', () => {
    const canvas = fakeCanvas();
    host.attach('tree', canvas as unknown as HTMLCanvasElement);
    FakeResizeObserver.instances[0].fire(canvas, 640, 320);

    expect(messagesOfType('canvas:resize')).toEqual([
      { type: 'canvas:resize', surfaceId: 'tree', size: { width: 640, height: 320, dpr: 2 } },
    ]);
  });

  it('re-sends sizes for every surface when the DPR changes', () => {
    host.attach('tree', fakeCanvas() as unknown as HTMLCanvasElement);
    host.attach('leaves', fakeCanvas() as unknown as HTMLCanvasElement);
    dpr = 3;
    dprListeners.forEach(l => l());

    expect(messagesOfType('canvas:resize').map(m => [m.surfaceId, m.size.dpr])).toEqual([['tree', 3], ['leaves', 3]]);
  });

  it('forwards visibility', () => {
    const canvas = fakeCanvas();
    host.attach('tree', canvas as unknown as HTMLCanvasElement);
    FakeIntersectionObserver.instances[0].fire(canvas, false);
    FakeIntersectionObserver.instances[0].fire(canvas, true);

    expect(messagesOfType('canvas:visible').map(m => m.visible)).toEqual([false, true]);
  });
});

// --- pointer -----------------------------------------------------------------

describe('pointer', () => {
  const move = (clientX: number, clientY: number, buttons = 0) =>
    pointerTarget.emit('pointermove', { clientX, clientY, buttons });

  it('listens under the full tier and forwards one sample per surface per frame, in canvas-local pixels', () => {
    host.attach('tree', fakeCanvas({ left: 100, top: 50, width: 300, height: 150 }) as unknown as HTMLCanvasElement);
    host.attach('leaves', fakeCanvas({ left: 0, top: 0, width: 50, height: 50 }) as unknown as HTMLCanvasElement);

    move(110, 60);
    move(120, 70);
    expect(messagesOfType('canvas:pointer')).toHaveLength(0);
    flushFrames();

    expect(messagesOfType('canvas:pointer')).toEqual([
      { type: 'canvas:pointer', surfaceId: 'tree', pointer: { x: 20, y: 20, down: false, inside: true, t: 1234 } },
      { type: 'canvas:pointer', surfaceId: 'leaves', pointer: { x: 120, y: 70, down: false, inside: false, t: 1234 } },
    ]);
  });

  it('reports buttons down and up', () => {
    host.attach('tree', fakeCanvas() as unknown as HTMLCanvasElement);
    pointerTarget.emit('pointerdown', { clientX: 150, clientY: 100, buttons: 1 });
    flushFrames();
    pointerTarget.emit('pointerup', { clientX: 150, clientY: 100, buttons: 0 });
    flushFrames();

    expect(messagesOfType('canvas:pointer').map(m => m.pointer.down)).toEqual([true, false]);
  });

  it('sends nothing when the pointer has not moved since the last frame', () => {
    host.attach('tree', fakeCanvas() as unknown as HTMLCanvasElement);
    move(150, 100);
    flushFrames();
    flushFrames();
    expect(messagesOfType('canvas:pointer')).toHaveLength(1);
  });

  it('does not listen under the ambient tier, and stops when dropping to it', () => {
    host.attach('tree', fakeCanvas() as unknown as HTMLCanvasElement);
    expect(pointerTarget.count('pointermove')).toBe(1);

    host.setTier('ambient');
    expect(pointerTarget.count('pointermove')).toBe(0);
    move(150, 100);
    flushFrames();
    expect(messagesOfType('canvas:pointer')).toHaveLength(0);

    host.setTier('full');
    expect(pointerTarget.count('pointermove')).toBe(1);
  });

  it('uses a fresh rect after a resize', () => {
    const canvas = fakeCanvas({ left: 0, top: 0, width: 300, height: 150 });
    host.attach('tree', canvas as unknown as HTMLCanvasElement);
    canvas.rect = { left: 50, top: 50, width: 300, height: 150 };
    FakeResizeObserver.instances[0].fire(canvas, 300, 150);
    move(60, 60);
    flushFrames();

    expect(messagesOfType('canvas:pointer')[0].pointer).toMatchObject({ x: 10, y: 10 });
  });
});

// --- tier --------------------------------------------------------------------

describe('tier', () => {
  it('forwards tier changes and reports the current one', () => {
    host.setTier('ambient');
    expect(host.tier).toBe('ambient');
    expect(messagesOfType('canvas:tier').map(m => m.tier)).toEqual(['full', 'ambient']);
  });

  it('adopts a tier the orchestrator stepped down to, and tells listeners', () => {
    const onTier = jest.fn();
    host.onTierChange(onTier);
    workerListeners.forEach(l => l({ type: 'canvas:tier-changed', tier: 'ambient', reason: 'over-budget' }));

    expect(host.tier).toBe('ambient');
    expect(onTier).toHaveBeenCalledWith('ambient', 'over-budget');
    expect(pointerTarget.count('pointermove')).toBe(0);
  });

  it('relays stats', () => {
    const onStats = jest.fn();
    const off = host.onStats(onStats);
    const stats = [{ surfaceId: 'tree', frames: 60, p50: 2, p95: 4, over: 0 }];
    workerListeners.forEach(l => l({ type: 'canvas:stats', tier: 'full', stats }));
    expect(onStats).toHaveBeenCalledWith(stats, 'full');

    off();
    workerListeners.forEach(l => l({ type: 'canvas:stats', tier: 'full', stats }));
    expect(onStats).toHaveBeenCalledTimes(1);
  });
});

// --- dispose -----------------------------------------------------------------

describe('dispose', () => {
  it('detaches everything at once and removes every listener', () => {
    host.attach('tree', fakeCanvas() as unknown as HTMLCanvasElement);
    host.attach('leaves', fakeCanvas() as unknown as HTMLCanvasElement);
    host.dispose();

    expect(messagesOfType('canvas:detach').map(m => m.surfaceId)).toEqual(['tree', 'leaves']);
    expect(pointerTarget.count('pointermove')).toBe(0);
    expect(workerListeners.size).toBe(0);
    expect(dprListeners).toHaveLength(0);
  });
});
