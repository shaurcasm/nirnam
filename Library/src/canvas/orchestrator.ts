/**
 * The orchestrator: one frame loop, N surfaces, inside a dedicated worker.
 *
 * One `requestAnimationFrame` drives every attached surface so they never
 * drift out of phase with each other or with vsync. Surfaces that are not
 * visible are skipped, and when nothing needs drawing the loop stops. That
 * includes the whole page being hidden: worker rAF keeps firing at full rate
 * in a background tab, so the host reports document visibility and the loop
 * stops on it explicitly.
 *
 * The orchestrator also measures itself. Every stats interval it reports
 * per-surface frame timing, and after sustained overrun it steps its own
 * tier down from `full` to `ambient` and says so — the host does not have
 * to notice.
 */

import type {
  FrameInput,
  HostMessage,
  MotionTier,
  OrchestratorMessage,
  PointerSample,
  Surface,
  SurfaceFactory,
  SurfaceSize,
  SurfaceStats,
  TierBudget,
  SurfaceEvent,
} from './types';
import { DEFAULT_BUDGETS } from './types';

/** What the orchestrator needs from its environment; `self` in a worker. */
export interface OrchestratorScope {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  postMessage(data: OrchestratorMessage): void;
}

/** Time and frame scheduling, injectable for tests. */
export interface OrchestratorClock {
  now(): number;
  requestFrame(callback: (time: number) => void): number;
  cancelFrame(id: number): void;
}

export interface OrchestratorOptions {
  surfaces: Record<string, SurfaceFactory>;
  /** Starting tier. Default `full`; the host normally sends the real one straight away. */
  tier?: MotionTier;
  budgets?: Partial<Record<Exclude<MotionTier, 'off'>, Partial<TierBudget>>>;
  /** How often frame timing is reported. Default 1000ms. */
  statsIntervalMs?: number;
  onStats?: (stats: SurfaceStats[], tier: MotionTier) => void;
  /** Consecutive over-budget intervals before stepping `full` down to `ambient`. Default 3; 0 disables. */
  stepDownAfter?: number;
  onTierChange?: (tier: MotionTier) => void;
  scope?: OrchestratorScope;
  clock?: OrchestratorClock;
}

export interface Orchestrator {
  readonly tier: MotionTier;
  readonly running: boolean;
  /** Feed a host message by hand — the same path scope messages take. */
  handle(message: HostMessage): void;
  setState(surfaceId: string, state: unknown): void;
  setTier(tier: MotionTier): void;
  dispose(): void;
}

/** The longest step a surface is asked to simulate, however long the real gap was. */
const MAX_DT = 100;
/** A frame is due once this fraction of the target interval has passed — tolerates rAF jitter. */
const FRAME_TOLERANCE = 0.75;

interface Slot {
  surface: Surface;
  canvas: OffscreenCanvas;
  size: SurfaceSize;
  visible: boolean;
  pointer: PointerSample | null;
  durations: number[];
  /** Costs reported through `FrameInput.report` this interval, by name. */
  events: Map<string, SurfaceEvent>;
  report: (name: string, ms: number) => void;
}

function defaultScope(): OrchestratorScope {
  return self as unknown as OrchestratorScope;
}

function defaultClock(): OrchestratorClock {
  const g = globalThis as unknown as {
    requestAnimationFrame?: (cb: (t: number) => void) => number;
    cancelAnimationFrame?: (id: number) => void;
  };
  const { requestAnimationFrame, cancelAnimationFrame } = g;
  if (requestAnimationFrame && cancelAnimationFrame) {
    return {
      now: () => performance.now(),
      requestFrame: (cb) => requestAnimationFrame(cb),
      cancelFrame: (id) => cancelAnimationFrame(id),
    };
  }
  // No rAF in this worker: a timer at roughly 60Hz.
  return {
    now: () => performance.now(),
    requestFrame: (cb) => setTimeout(() => cb(performance.now()), 16) as unknown as number,
    cancelFrame: (id) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>),
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank))];
}

export function createOrchestrator(options: OrchestratorOptions): Orchestrator {
  const {
    surfaces,
    statsIntervalMs = 1000,
    onStats,
    stepDownAfter = 3,
    onTierChange,
    scope = defaultScope(),
    clock = defaultClock(),
  } = options;

  const budgets = {
    full: { ...DEFAULT_BUDGETS.full, ...options.budgets?.full },
    ambient: { ...DEFAULT_BUDGETS.ambient, ...options.budgets?.ambient },
  };

  let tier: MotionTier = options.tier ?? 'full';
  let pageHidden = false;
  const slots = new Map<string, Slot>();
  let frameId: number | null = null;
  let startedAt: number | null = null;
  let lastFrameAt: number | null = null;
  let lastStatsAt: number | null = null;
  let overBudgetIntervals = 0;

  // ---- budget ----------------------------------------------------------------

  const budget = (): TierBudget => (tier === 'ambient' ? budgets.ambient : budgets.full);
  const frameMs = () => 1000 / budget().targetFps;

  function applySize(slot: Slot, requested: SurfaceSize): SurfaceSize {
    const dpr = Math.min(requested.dpr, budget().maxDpr);
    const size = { width: requested.width, height: requested.height, dpr };
    slot.canvas.width = Math.round(size.width * dpr);
    slot.canvas.height = Math.round(size.height * dpr);
    slot.size = size;
    return size;
  }

  // ---- loop ------------------------------------------------------------------

  const shouldRun = () =>
    tier !== 'off' && !pageHidden && [...slots.values()].some(slot => slot.visible);

  function schedule() {
    if (frameId !== null || !shouldRun()) return;
    if (startedAt === null) startedAt = clock.now();
    frameId = clock.requestFrame(onFrame);
  }

  function unschedule() {
    if (frameId !== null) {
      clock.cancelFrame(frameId);
      frameId = null;
    }
  }

  function reconcile() {
    if (shouldRun()) schedule();
    else unschedule();
  }

  function onFrame() {
    frameId = null;
    const now = clock.now();
    if (lastStatsAt === null) lastStatsAt = now;

    const due = lastFrameAt === null || now - lastFrameAt >= frameMs() * FRAME_TOLERANCE;
    if (due) {
      const dt = lastFrameAt === null ? 0 : Math.min(now - lastFrameAt, MAX_DT);
      lastFrameAt = now;
      const elapsed = now - (startedAt ?? now);

      slots.forEach(slot => {
        if (!slot.visible) return;
        const input: FrameInput = {
          pointer: tier === 'full' ? slot.pointer : null,
          tier,
          size: slot.size,
          elapsed,
          report: slot.report,
        };
        const before = clock.now();
        slot.surface.frame(dt, input);
        slot.durations.push(clock.now() - before);
      });

      if (clock.now() - lastStatsAt >= statsIntervalMs) reportStats();
    }

    schedule();
  }

  // ---- stats -----------------------------------------------------------------

  function reportStats() {
    lastStatsAt = clock.now();
    const limit = frameMs();
    const stats: SurfaceStats[] = [];
    slots.forEach((slot, surfaceId) => {
      const sorted = slot.durations.slice().sort((a, b) => a - b);
      stats.push({
        surfaceId,
        frames: sorted.length,
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
        over: sorted.filter(d => d > limit).length,
        events: [...slot.events.values()],
      });
      slot.durations = [];
      slot.events = new Map();
    });

    scope.postMessage({ type: 'canvas:stats', tier, stats });
    onStats?.(stats, tier);

    if (stepDownAfter > 0 && tier === 'full') {
      const over = stats.some(s => s.frames > 0 && s.p95 > limit);
      overBudgetIntervals = over ? overBudgetIntervals + 1 : 0;
      if (overBudgetIntervals >= stepDownAfter) {
        overBudgetIntervals = 0;
        setTier('ambient');
        scope.postMessage({ type: 'canvas:tier-changed', tier: 'ambient', reason: 'over-budget' });
      }
    }
  }

  // ---- surfaces --------------------------------------------------------------

  function attach(surfaceId: string, canvas: OffscreenCanvas, size: SurfaceSize) {
    const factory = surfaces[surfaceId];
    if (!factory) return;
    detach(surfaceId);
    const slot: Slot = {
      surface: factory(),
      canvas,
      size,
      visible: true,
      pointer: null,
      durations: [],
      events: new Map(),
      report: (name, ms) => {
        const event = slot.events.get(name) ?? { name, count: 0, ms: 0 };
        event.count += 1;
        event.ms += ms;
        slot.events.set(name, event);
      },
    };
    slots.set(surfaceId, slot);
    slot.surface.attach(canvas, applySize(slot, size));
    reconcile();
  }

  function detach(surfaceId: string) {
    const slot = slots.get(surfaceId);
    if (!slot) return;
    slots.delete(surfaceId);
    slot.surface.detach?.();
    reconcile();
  }

  function setTier(next: MotionTier) {
    if (next === tier) return;
    tier = next;
    overBudgetIntervals = 0;
    slots.forEach(slot => {
      if (tier !== 'full') slot.pointer = null;
      if (tier !== 'off') slot.surface.resize?.(applySize(slot, slot.size));
    });
    onTierChange?.(tier);
    reconcile();
  }

  function handle(message: HostMessage) {
    if (!message || typeof message !== 'object') return;
    switch (message.type) {
      case 'canvas:attach':
        attach(message.surfaceId, message.canvas, message.size);
        break;
      case 'canvas:detach':
        detach(message.surfaceId);
        break;
      case 'canvas:resize': {
        const slot = slots.get(message.surfaceId);
        if (slot) slot.surface.resize?.(applySize(slot, message.size));
        break;
      }
      case 'canvas:visible': {
        const slot = slots.get(message.surfaceId);
        if (slot) {
          slot.visible = message.visible;
          reconcile();
        }
        break;
      }
      case 'canvas:pointer': {
        const slot = slots.get(message.surfaceId);
        if (slot && tier === 'full') slot.pointer = message.pointer;
        break;
      }
      case 'canvas:state':
        slots.get(message.surfaceId)?.surface.onState?.(message.state);
        break;
      case 'canvas:tier':
        setTier(message.tier);
        break;
      case 'canvas:page-hidden':
        pageHidden = message.hidden;
        reconcile();
        break;
    }
  }

  const onMessage = (event: MessageEvent) => handle(event.data as HostMessage);
  scope.addEventListener('message', onMessage);

  return {
    get tier() {
      return tier;
    },
    get running() {
      return frameId !== null;
    },
    handle,
    setState: (surfaceId, state) => slots.get(surfaceId)?.surface.onState?.(state),
    setTier,
    dispose() {
      scope.removeEventListener('message', onMessage);
      [...slots.keys()].forEach(detach);
      unschedule();
    },
  };
}
