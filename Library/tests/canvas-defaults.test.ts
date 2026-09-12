/**
 * The browser defaults behind the canvas runtime's injectable dependencies:
 * what the host uses when nothing is injected, and what the orchestrator
 * uses for its clock and scope. Run against fake globals.
 */

import { CanvasHostController } from '../src/canvas/host';
import { createOrchestrator } from '../src/canvas/orchestrator';
import type { HostMessage } from '../src/canvas/types';

const g = globalThis as unknown as Record<string, unknown>;
const saved: Record<string, unknown> = {};
const GLOBALS = ['window', 'document', 'devicePixelRatio', 'matchMedia', 'requestAnimationFrame', 'cancelAnimationFrame', 'self'];

beforeEach(() => {
  GLOBALS.forEach(k => { saved[k] = g[k]; });
  jest.useFakeTimers();
});

afterEach(() => {
  GLOBALS.forEach(k => {
    if (saved[k] === undefined) delete g[k];
    else g[k] = saved[k];
  });
  jest.useRealTimers();
});

// --- host --------------------------------------------------------------------

describe('CanvasHostController browser defaults', () => {
  interface FakeQuery { matches: boolean; listeners: Set<() => void>; addEventListener: jest.Mock; removeEventListener: jest.Mock }
  let queries: FakeQuery[];
  let posted: HostMessage[];
  let rafCallbacks: Array<() => void>;
  let windowListeners: Map<string, Set<(e: unknown) => void>>;

  function installBrowser() {
    queries = [];
    posted = [];
    rafCallbacks = [];
    windowListeners = new Map();
    g.devicePixelRatio = 2;
    g.matchMedia = jest.fn((query: string) => {
      const q: FakeQuery = {
        matches: query.includes('2dppx'),
        listeners: new Set(),
        addEventListener: jest.fn((_t: string, l: () => void) => q.listeners.add(l)),
        removeEventListener: jest.fn((_t: string, l: () => void) => q.listeners.delete(l)),
      };
      queries.push(q);
      return q;
    });
    g.requestAnimationFrame = jest.fn((cb: () => void) => rafCallbacks.push(cb));
    g.cancelAnimationFrame = jest.fn(() => { rafCallbacks.length = 0; });
    g.window = {
      addEventListener: (type: string, l: (e: unknown) => void) => {
        if (!windowListeners.has(type)) windowListeners.set(type, new Set());
        windowListeners.get(type)!.add(l);
      },
      removeEventListener: (type: string, l: (e: unknown) => void) => windowListeners.get(type)?.delete(l),
    };
    g.document = {
      visibilityState: 'visible',
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    };
  }

  function makeHost() {
    return new CanvasHostController(
      { post: (m) => posted.push(m), onMessage: () => () => {} },
      { tier: 'full' },
    );
  }

  const canvas = () => ({
    transferControlToOffscreen: jest.fn(() => ({ width: 0, height: 0 })),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 50 }),
  }) as unknown as HTMLCanvasElement;

  it('transfers with transferControlToOffscreen and reads window.devicePixelRatio', () => {
    installBrowser();
    const host = makeHost();
    const el = canvas();
    host.attach('s', el);

    expect((el as unknown as { transferControlToOffscreen: jest.Mock }).transferControlToOffscreen).toHaveBeenCalledTimes(1);
    expect(posted.find(m => m.type === 'canvas:attach')).toMatchObject({ size: { width: 100, height: 50, dpr: 2 } });
    host.dispose();
  });

  it('watches the DPR with a re-armed media query and resends sizes on change', () => {
    installBrowser();
    const host = makeHost();
    host.attach('s', canvas());
    expect(queries).toHaveLength(1);

    g.devicePixelRatio = 3;
    queries[0].listeners.forEach(l => l());

    expect(queries).toHaveLength(2);                           // re-armed for the new ratio
    expect(queries[0].removeEventListener).toHaveBeenCalled();
    expect(posted.filter(m => m.type === 'canvas:resize')).toEqual([
      { type: 'canvas:resize', surfaceId: 's', size: { width: 100, height: 50, dpr: 3 } },
    ]);

    host.dispose();
    expect(queries[1].removeEventListener).toHaveBeenCalled();
  });

  it('batches pointer events on requestAnimationFrame and defers detach on a timer', () => {
    installBrowser();
    const host = makeHost();
    const handle = host.attach('s', canvas());

    windowListeners.get('pointermove')!.forEach(l => l({ clientX: 10, clientY: 5, buttons: 0 }));
    expect(posted.filter(m => m.type === 'canvas:pointer')).toHaveLength(0);
    rafCallbacks.splice(0).forEach(cb => cb());
    expect(posted.filter(m => m.type === 'canvas:pointer')).toHaveLength(1);

    handle.detach();
    expect(posted.filter(m => m.type === 'canvas:detach')).toHaveLength(0);
    jest.runAllTimers();
    expect(posted.filter(m => m.type === 'canvas:detach')).toHaveLength(1);
    host.dispose();
  });

  it('cancels a pending pointer flush when leaving the full tier', () => {
    installBrowser();
    const host = makeHost();
    host.attach('s', canvas());
    windowListeners.get('pointermove')!.forEach(l => l({ clientX: 1, clientY: 1, buttons: 0 }));
    host.setTier('ambient');
    expect(g.cancelAnimationFrame).toHaveBeenCalled();
    host.dispose();
  });

  it('reads document visibility from the real document by default', () => {
    installBrowser();
    (g.document as { visibilityState: string }).visibilityState = 'hidden';
    const host = makeHost();
    expect(posted).toContainEqual({ type: 'canvas:page-hidden', hidden: true });
    expect((g.document as { addEventListener: jest.Mock }).addEventListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    host.dispose();
    expect((g.document as { removeEventListener: jest.Mock }).removeEventListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
  });

  it('copes without matchMedia, rAF, window or document', () => {
    installBrowser();
    delete g.matchMedia;
    delete g.requestAnimationFrame;
    delete g.cancelAnimationFrame;
    delete g.document;
    g.window = { addEventListener: () => {}, removeEventListener: () => {} };
    g.devicePixelRatio = undefined;

    const host = makeHost();
    const handle = host.attach('s', canvas());
    expect(posted.find(m => m.type === 'canvas:attach')).toMatchObject({ size: { dpr: 1 } });
    handle.detach();
    jest.runAllTimers();
    expect(posted.filter(m => m.type === 'canvas:detach')).toHaveLength(1);
    host.dispose();
  });
});

// --- orchestrator ------------------------------------------------------------

describe('createOrchestrator browser defaults', () => {
  const scope = () => ({
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    postMessage: jest.fn(),
  });
  const surface = () => ({ attach: jest.fn(), frame: jest.fn() });
  const attach = (o: ReturnType<typeof createOrchestrator>) =>
    o.handle({ type: 'canvas:attach', surfaceId: 's', canvas: { width: 0, height: 0 } as OffscreenCanvas, size: { width: 1, height: 1, dpr: 1 } });

  it('uses self as the scope and requestAnimationFrame as the clock when present', () => {
    const s = scope();
    g.self = s;
    const raf: Array<(t: number) => void> = [];
    g.requestAnimationFrame = jest.fn((cb: (t: number) => void) => raf.push(cb));
    g.cancelAnimationFrame = jest.fn();

    const surf = surface();
    const o = createOrchestrator({ surfaces: { s: () => surf } });
    expect(s.addEventListener).toHaveBeenCalledWith('message', expect.any(Function));

    attach(o);
    expect(g.requestAnimationFrame).toHaveBeenCalledTimes(1);
    raf.splice(0).forEach(cb => cb(performance.now()));
    expect(surf.frame).toHaveBeenCalledTimes(1);

    o.dispose();
    expect(g.cancelAnimationFrame).toHaveBeenCalled();
  });

  it('falls back to a timer when the worker has no requestAnimationFrame', () => {
    g.self = scope();
    delete g.requestAnimationFrame;
    delete g.cancelAnimationFrame;

    const surf = surface();
    const o = createOrchestrator({ surfaces: { s: () => surf } });
    attach(o);
    jest.advanceTimersByTime(20);
    expect(surf.frame).toHaveBeenCalledTimes(1);

    o.dispose();
    jest.advanceTimersByTime(100);
    expect(surf.frame).toHaveBeenCalledTimes(1);
  });
});
