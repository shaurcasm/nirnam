/**
 * The orchestrator: one frame loop driving N surfaces inside a worker.
 *
 * Driven here with a fake clock and a fake worker scope, so frames are
 * stepped by hand and every message the host could send is exercised.
 */

import { createOrchestrator } from '../src/canvas/orchestrator';
import type { Orchestrator, OrchestratorClock } from '../src/canvas/orchestrator';
import type { Surface, SurfaceSize, FrameInput, HostMessage, OrchestratorMessage } from '../src/canvas/types';

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
  /** Advance time and fire every pending frame callback once. */
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

function fakeScope() {
  const listeners = new Set<(event: MessageEvent) => void>();
  return {
    posted: [] as OrchestratorMessage[],
    addEventListener: jest.fn((_type: 'message', l: (event: MessageEvent) => void) => listeners.add(l)),
    removeEventListener: jest.fn((_type: 'message', l: (event: MessageEvent) => void) => listeners.delete(l)),
    postMessage: jest.fn(function (this: void, data: OrchestratorMessage) {
      scope.posted.push(data);
    }),
    /** Deliver a host message as the worker's own 'message' event. */
    receive(data: HostMessage) {
      listeners.forEach(l => l({ data } as MessageEvent));
    },
  };
}
let scope: ReturnType<typeof fakeScope>;

interface RecordingSurface extends Surface<{ colour: string }> {
  attached: { canvas: OffscreenCanvas; size: SurfaceSize } | null;
  sizes: SurfaceSize[];
  frames: Array<{ dt: number; input: FrameInput }>;
  states: Array<{ colour: string }>;
  detached: number;
  /** Simulated cost of one frame in ms; the clock advances by it inside frame(). */
  cost: number;
}

function recordingSurface(clock: FakeClock): RecordingSurface {
  const s: RecordingSurface = {
    attached: null,
    sizes: [],
    frames: [],
    states: [],
    detached: 0,
    cost: 0,
    attach: (canvas, size) => { s.attached = { canvas, size }; },
    resize: (size) => { s.sizes.push(size); },
    frame: (dt, input) => { clock.time += s.cost; s.frames.push({ dt, input }); },
    onState: (state) => { s.states.push(state); },
    detach: () => { s.detached += 1; },
  };
  return s;
}

function canvas(): OffscreenCanvas {
  return { width: 0, height: 0 } as OffscreenCanvas;
}

const size = (width = 300, height = 150, dpr = 2): SurfaceSize => ({ width, height, dpr });

// --- Setup -------------------------------------------------------------------

let clock: FakeClock;
let tree: RecordingSurface;
let leaves: RecordingSurface;
let made: Record<string, number>;

let orchestrator: Orchestrator | null = null;

function make(options: Partial<Parameters<typeof createOrchestrator>[0]> = {}) {
  orchestrator?.dispose();
  made = { tree: 0, leaves: 0 };
  orchestrator = createOrchestrator({
    surfaces: {
      tree: () => { made.tree += 1; return tree; },
      leaves: () => { made.leaves += 1; return leaves; },
    },
    scope,
    clock,
    ...options,
  });
  return orchestrator;
}

function attach(surfaceId: string, s: SurfaceSize = size()) {
  scope.receive({ type: 'canvas:attach', surfaceId, canvas: canvas(), size: s });
}

beforeEach(() => {
  clock = new FakeClock();
  scope = fakeScope();
  tree = recordingSurface(clock);
  leaves = recordingSurface(clock);
  make();
});

afterEach(() => {
  orchestrator?.dispose();
  orchestrator = null;
});

// --- attach / detach ---------------------------------------------------------

describe('attach', () => {
  it('creates the surface from its factory and attaches the canvas at the capped DPR', () => {
    attach('tree', size(300, 150, 3));

    expect(made.tree).toBe(1);
    expect(tree.attached?.size).toEqual({ width: 300, height: 150, dpr: 2 }); // full tier caps at 2
    expect(tree.attached?.canvas.width).toBe(600);
    expect(tree.attached?.canvas.height).toBe(300);
  });

  it('starts the frame loop once a surface is attached, and not before', () => {
    expect(orchestrator!.running).toBe(false);
    attach('tree');
    expect(orchestrator!.running).toBe(true);
  });

  it('ignores an attach for an unknown surface id', () => {
    scope.receive({ type: 'canvas:attach', surfaceId: 'nope', canvas: canvas(), size: size() });
    expect(orchestrator!.running).toBe(false);
  });

  it('replaces a surface attached twice under the same id, detaching the first', () => {
    attach('tree');
    attach('tree');
    expect(made.tree).toBe(2);
    expect(tree.detached).toBe(1);
  });
});

describe('detach', () => {
  it('detaches the surface and stops the loop when none remain', () => {
    attach('tree');
    scope.receive({ type: 'canvas:detach', surfaceId: 'tree' });

    expect(tree.detached).toBe(1);
    expect(orchestrator!.running).toBe(false);
    clock.tick();
    expect(tree.frames).toHaveLength(0);
  });

  it('keeps running while another surface is attached', () => {
    attach('tree');
    attach('leaves');
    scope.receive({ type: 'canvas:detach', surfaceId: 'tree' });
    expect(orchestrator!.running).toBe(true);
  });

  it('ignores a detach for a surface that is not attached', () => {
    expect(() => scope.receive({ type: 'canvas:detach', surfaceId: 'tree' })).not.toThrow();
  });
});

// --- the loop ----------------------------------------------------------------

describe('frame loop', () => {
  it('drives every attached surface from one frame callback', () => {
    attach('tree');
    attach('leaves');
    expect(clock.scheduled).toBe(1);

    clock.tick(16);
    expect(tree.frames).toHaveLength(1);
    expect(leaves.frames).toHaveLength(1);
    expect(clock.scheduled).toBe(1);
  });

  it('passes dt since the previous frame and the elapsed time', () => {
    attach('tree');
    clock.tick(16);
    clock.tick(20);

    expect(tree.frames[1].dt).toBe(20);
    expect(tree.frames[1].input.elapsed).toBe(36);
  });

  it('caps dt so a long pause does not produce a huge step', () => {
    attach('tree');
    clock.tick(16);
    clock.tick(5000);
    expect(tree.frames[1].dt).toBe(100);
  });

  it('skips a surface reported as not visible, and resumes when it is', () => {
    attach('tree');
    scope.receive({ type: 'canvas:visible', surfaceId: 'tree', visible: false });
    clock.tick();
    expect(tree.frames).toHaveLength(0);
    expect(orchestrator!.running).toBe(false);

    scope.receive({ type: 'canvas:visible', surfaceId: 'tree', visible: true });
    clock.tick();
    expect(tree.frames).toHaveLength(1);
  });

  it('stops while the page is hidden — worker rAF is not throttled for background tabs — and resumes', () => {
    attach('tree');
    scope.receive({ type: 'canvas:page-hidden', hidden: true });
    expect(orchestrator!.running).toBe(false);
    clock.tick();
    expect(tree.frames).toHaveLength(0);

    scope.receive({ type: 'canvas:page-hidden', hidden: false });
    expect(orchestrator!.running).toBe(true);
    clock.tick();
    expect(tree.frames).toHaveLength(1);
  });

  it('does not start when a surface attaches while the page is hidden', () => {
    scope.receive({ type: 'canvas:page-hidden', hidden: true });
    attach('tree');
    expect(orchestrator!.running).toBe(false);
  });

  it('holds the ambient tier to its target frame rate', () => {
    make({ tier: 'ambient' });
    attach('tree');
    for (let i = 0; i < 6; i++) clock.tick(16); // ~96ms at 60Hz callbacks
    // 30fps budget is 33ms: frames at ~32, ~64, ~96 → 3, not 6
    expect(tree.frames.length).toBeLessThanOrEqual(3);
    expect(tree.frames.length).toBeGreaterThanOrEqual(2);
  });

  it('does not run under the off tier', () => {
    make({ tier: 'off' });
    attach('tree');
    expect(orchestrator!.running).toBe(false);
  });
});

// --- input -------------------------------------------------------------------

describe('input', () => {
  it('gives each surface its own latest pointer sample under the full tier', () => {
    attach('tree');
    attach('leaves');
    const sample = { x: 10, y: 20, down: false, inside: true, t: 1 };
    scope.receive({ type: 'canvas:pointer', surfaceId: 'tree', pointer: sample });
    clock.tick();

    expect(tree.frames[0].input.pointer).toEqual(sample);
    expect(leaves.frames[0].input.pointer).toBeNull();
  });

  it('withholds the pointer under the ambient tier', () => {
    make({ tier: 'ambient' });
    attach('tree');
    scope.receive({ type: 'canvas:pointer', surfaceId: 'tree', pointer: { x: 1, y: 1, down: false, inside: true, t: 0 } });
    clock.tick(40);
    expect(tree.frames[0].input.pointer).toBeNull();
  });

  it('forwards state to the surface', () => {
    attach('tree');
    scope.receive({ type: 'canvas:state', surfaceId: 'tree', state: { colour: 'green' } });
    orchestrator!.setState('tree', { colour: 'gold' });
    expect(tree.states).toEqual([{ colour: 'green' }, { colour: 'gold' }]);
  });

  it('resizes through the DPR cap', () => {
    attach('tree');
    scope.receive({ type: 'canvas:resize', surfaceId: 'tree', size: size(400, 200, 3) });
    expect(tree.sizes).toEqual([{ width: 400, height: 200, dpr: 2 }]);
    expect(tree.attached?.canvas.width).toBe(800);
  });

  it('ignores pointer, state, resize and visibility for surfaces not attached', () => {
    expect(() => {
      scope.receive({ type: 'canvas:pointer', surfaceId: 'tree', pointer: { x: 0, y: 0, down: false, inside: false, t: 0 } });
      scope.receive({ type: 'canvas:state', surfaceId: 'tree', state: {} });
      scope.receive({ type: 'canvas:resize', surfaceId: 'tree', size: size() });
      scope.receive({ type: 'canvas:visible', surfaceId: 'tree', visible: false });
    }).not.toThrow();
  });

  it('ignores messages that are not for it', () => {
    expect(() => scope.receive({ type: 'nirnam:connect' } as unknown as HostMessage)).not.toThrow();
    expect(() => scope.receive(null as unknown as HostMessage)).not.toThrow();
  });
});

// --- tier --------------------------------------------------------------------

describe('tier', () => {
  it('re-applies the DPR cap to attached surfaces when the tier changes', () => {
    attach('tree', size(300, 150, 3));
    scope.receive({ type: 'canvas:tier', tier: 'ambient' });

    expect(orchestrator!.tier).toBe('ambient');
    expect(tree.sizes).toEqual([{ width: 300, height: 150, dpr: 1.5 }]);
    expect(tree.attached?.canvas.width).toBe(450);
  });

  it('stops the loop on off and restarts it on full', () => {
    attach('tree');
    orchestrator!.setTier('off');
    expect(orchestrator!.running).toBe(false);
    orchestrator!.setTier('full');
    expect(orchestrator!.running).toBe(true);
  });

  it('clears any held pointer when dropping to ambient', () => {
    attach('tree');
    scope.receive({ type: 'canvas:pointer', surfaceId: 'tree', pointer: { x: 1, y: 1, down: false, inside: true, t: 0 } });
    orchestrator!.setTier('ambient');
    orchestrator!.setTier('full');
    clock.tick();
    expect(tree.frames[0].input.pointer).toBeNull();
  });
});

// --- stats and self-regulation -----------------------------------------------

describe('stats', () => {
  it('posts per-surface frame timing once per interval', () => {
    const onStats = jest.fn();
    make({ statsIntervalMs: 100, onStats });
    attach('tree');
    tree.cost = 4;

    for (let i = 0; i < 8; i++) clock.tick(16);

    expect(onStats).toHaveBeenCalledTimes(1);
    const [stats, tier] = onStats.mock.calls[0];
    expect(tier).toBe('full');
    expect(stats).toEqual([{ surfaceId: 'tree', frames: expect.any(Number), p50: 4, p95: 4, over: 0, events: [] }]);
    expect(scope.posted).toContainEqual({ type: 'canvas:stats', tier: 'full', stats });
  });

  it('totals the costs a surface reports, by name, and starts each interval afresh', () => {
    make({ statsIntervalMs: 100 });
    attach('tree');
    const report = (name: string, ms: number) => tree.frames[tree.frames.length - 1].input.report?.(name, ms);

    clock.tick(16);
    report('rebuild', 40);
    clock.tick(16);
    report('rebuild', 50);
    report('upload', 3);
    for (let i = 0; i < 6; i++) clock.tick(16);

    const first = (scope.posted[0] as { stats: Array<{ events: unknown }> }).stats[0];
    expect(first.events).toEqual([
      { name: 'rebuild', count: 2, ms: 90 },
      { name: 'upload', count: 1, ms: 3 },
    ]);

    for (let i = 0; i < 7; i++) clock.tick(16);
    const second = (scope.posted[1] as { stats: Array<{ events: unknown }> }).stats[0];
    expect(second.events).toEqual([]);
  });

  it('counts frames over the tier budget', () => {
    make({ statsIntervalMs: 100 });
    attach('tree');
    tree.cost = 20; // over the 16.7ms full-tier budget

    for (let i = 0; i < 8; i++) clock.tick(16);

    const stats = (scope.posted[0] as { stats: Array<{ over: number; frames: number }> }).stats[0];
    expect(stats.over).toBe(stats.frames);
  });

  it('steps down from full to ambient after sustained overrun, and says so', () => {
    const onTierChange = jest.fn();
    make({ statsIntervalMs: 100, stepDownAfter: 3, onTierChange });
    attach('tree');
    tree.cost = 20; // each tick is 36ms of clock: two intervals in 8 ticks, five in 16

    for (let i = 0; i < 8; i++) clock.tick(16);
    expect(orchestrator!.tier).toBe('full');

    for (let i = 0; i < 8; i++) clock.tick(16);
    expect(orchestrator!.tier).toBe('ambient');
    expect(onTierChange).toHaveBeenCalledWith('ambient');
    expect(scope.posted).toContainEqual({ type: 'canvas:tier-changed', tier: 'ambient', reason: 'over-budget' });
  });

  it('resets the overrun count when an interval is within budget', () => {
    make({ statsIntervalMs: 100, stepDownAfter: 4 });
    attach('tree');

    // The first interval after a cost change is mixed and still counts as
    // over, so each over phase below yields three over intervals — one short
    // of the threshold — as long as the within phase in between resets.
    tree.cost = 20;
    for (let i = 0; i < 8; i++) clock.tick(16);
    tree.cost = 1;
    for (let i = 0; i < 16; i++) clock.tick(16);
    tree.cost = 20;
    for (let i = 0; i < 8; i++) clock.tick(16);

    const over = scope.posted
      .filter(m => m.type === 'canvas:stats')
      .map(m => (m as { stats: Array<{ p95: number }> }).stats[0].p95 > 1000 / 60);
    expect(over.filter(Boolean).length).toBeGreaterThanOrEqual(4); // more overs than the threshold in total…
    expect(over.join('')).toMatch(/false/);                         // …separated by at least one within
    expect(orchestrator!.tier).toBe('full');                        // so never four in a row
  });

  it('never steps down below ambient on its own', () => {
    make({ tier: 'ambient', statsIntervalMs: 100, stepDownAfter: 1 });
    attach('tree');
    tree.cost = 50;
    for (let i = 0; i < 8; i++) clock.tick(16);
    expect(orchestrator!.tier).toBe('ambient');
  });

  it('can be disabled with stepDownAfter: 0', () => {
    make({ statsIntervalMs: 100, stepDownAfter: 0 });
    attach('tree');
    tree.cost = 50;
    for (let i = 0; i < 24; i++) clock.tick(16);
    expect(orchestrator!.tier).toBe('full');
  });
});

// --- lifecycle ---------------------------------------------------------------

describe('dispose', () => {
  it('detaches every surface, cancels the frame and stops listening', () => {
    attach('tree');
    attach('leaves');
    orchestrator!.dispose();

    expect(tree.detached).toBe(1);
    expect(leaves.detached).toBe(1);
    expect(clock.scheduled).toBe(0);
    expect(scope.removeEventListener).toHaveBeenCalledTimes(1);
    expect(orchestrator!.running).toBe(false);
  });
});
