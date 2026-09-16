/**
 * The canvas workload: with the surface drawing at the chosen load, type
 * into a React-controlled input for `durationMs`, one synthetic keystroke
 * every `keyEveryMs`, and measure how long each keystroke took to commit.
 * The surface's own stats come along so both arms can be seen to have
 * drawn the same frames.
 */

import type { SurfaceStats } from '@palinc/nirnam/canvas';
import type { Metrics } from '../harness/stats';
import { summarise } from '../harness/stats';
import { typingLatency } from '../harness/probes';
import { measured } from '../harness/runner';

export interface CanvasParams {
  strips: number;
  durationMs: number;
  keyEveryMs: number;
}

export const DEFAULT_CANVAS_PARAMS: CanvasParams = { strips: 400, durationMs: 8000, keyEveryMs: 60 };

/** What the tab gives the workload: a mounted stage and a way to type into it. */
export interface CanvasHarness {
  /** Resolves once the surface is attached and has reported stats at least once. */
  mount(): Promise<void>;
  unmount(): Promise<void>;
  /** One synthetic keystroke; `committed` is called from the component's layout effect. */
  type(): void;
  onCommit(listener: () => void): () => void;
  /** Stats intervals reported since mount. */
  stats(): SurfaceStats[];
}

/** Fold the orchestrator's per-interval stats into one row of metrics. */
export function summariseSurfaceStats(samples: SurfaceStats[]): Metrics {
  const frames = samples.reduce((s, x) => s + x.frames, 0);
  const over = samples.reduce((s, x) => s + x.over, 0);
  const p95 = summarise(samples.filter(x => x.frames > 0).map(x => x.p95)).p50;
  const rebuilds = samples.flatMap(x => x.events).filter(e => e.name.endsWith('rebuild'));
  return {
    'surface.frames': frames,
    'surface.p95': p95,
    'surface.over': over,
    'rebuild.count': rebuilds.reduce((s, e) => s + e.count, 0),
    'rebuild.ms': rebuilds.reduce((s, e) => s + e.ms, 0),
  };
}

export async function runCanvasWorkload(harness: CanvasHarness, params: CanvasParams): Promise<Metrics> {
  await harness.mount();
  try {
    return await measured(async () => {
      const typing = typingLatency();
      const off = harness.onCommit(() => typing.committed());
      const start = performance.now();
      while (performance.now() - start < params.durationMs) {
        typing.pressed();
        harness.type();
        await new Promise(r => setTimeout(r, params.keyEveryMs));
      }
      off();
      const t = typing.stop();
      return {
        'typing.p50': t.p50,
        'typing.p95': t.p95,
        'typing.max': t.max,
        keystrokes: t.n,
        ...summariseSurfaceStats(harness.stats()),
      };
    });
  } finally {
    await harness.unmount();
  }
}
