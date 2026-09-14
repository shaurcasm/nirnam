/**
 * The runner: every case (an arm × a workload) is run once to warm up and
 * then `reps` times; the table shows the per-metric median. Between runs
 * the thread is given a moment to settle so one case's tail does not land
 * in the next one's numbers.
 *
 * `measured()` wraps a run in the main-thread probes every tab shares, so
 * the columns line up whatever was being measured.
 */

import { medianOf, type Metrics } from './stats';
import { eventLoopLag, longFrames, mainFps } from './probes';

export interface Case {
  arm: string;
  armLabel: string;
  workload: string;
  workloadLabel: string;
  /** Absent when the arm cannot do this workload; say why in `unsupported`. */
  run?: () => Promise<Metrics>;
  unsupported?: string;
}

export interface CaseResult {
  arm: string;
  armLabel: string;
  workload: string;
  workloadLabel: string;
  /** Median across repetitions; null when unsupported. */
  metrics: Metrics | null;
  runs: Metrics[];
  unsupported?: string;
  error?: string;
}

export interface RunOptions {
  reps?: number;
  warmup?: number;
  onProgress?(progress: { done: number; total: number; current: Case | null }): void;
  signal?: AbortSignal;
  /** Called between runs; the default yields for 150ms. */
  settle?: () => Promise<void>;
}

const defaultSettle = () => new Promise<void>(resolve => setTimeout(resolve, 150));

export async function runCases(cases: Case[], options: RunOptions = {}): Promise<CaseResult[]> {
  const { reps = 3, warmup = 1, onProgress, signal, settle = defaultSettle } = options;
  const runnable = cases.filter(c => c.run);
  const total = runnable.length * (reps + warmup);
  let done = 0;
  const results: CaseResult[] = [];

  for (const c of cases) {
    const base = { arm: c.arm, armLabel: c.armLabel, workload: c.workload, workloadLabel: c.workloadLabel };
    if (!c.run) {
      results.push({ ...base, metrics: null, runs: [], unsupported: c.unsupported ?? 'not supported' });
      continue;
    }
    const runs: Metrics[] = [];
    let error: string | undefined;
    for (let i = 0; i < warmup + reps; i++) {
      if (signal?.aborted) break;
      onProgress?.({ done, total, current: c });
      try {
        const metrics = await c.run();
        if (i >= warmup) runs.push(metrics);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        break;
      }
      done += 1;
      await settle();
    }
    results.push({ ...base, metrics: runs.length ? medianOf(runs) : null, runs, error });
  }
  onProgress?.({ done, total, current: null });
  return results;
}

/**
 * Run `body` with the shared main-thread probes around it. What the body
 * returns is merged with `lag.*`, `fps.*`, `longFrames` and `blockingMs`.
 */
export async function measured(body: () => Promise<Metrics>): Promise<Metrics> {
  const stopLag = eventLoopLag();
  const stopFps = mainFps();
  const stopLong = longFrames();
  try {
    const own = await body();
    const lag = stopLag();
    const fps = stopFps();
    const long = stopLong();
    return {
      ...own,
      'lag.p50': lag.p50,
      'lag.p95': lag.p95,
      'lag.max': lag.max,
      'fps.median': fps.fpsMedian,
      'fps.p5': fps.fpsP5,
      longFrames: long.count,
      blockingMs: long.blockingMs,
    };
  } catch (e) {
    stopLag();
    stopFps();
    stopLong();
    throw e;
  }
}

/** Yield to the event loop: lets queued messages land before the next step. */
export const nextTask = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/** Hold the thread for `ms` milliseconds of real work — a stand-in for a tool that computes. */
export function spin(ms: number): number {
  const until = performance.now() + ms;
  let x = 0;
  while (performance.now() < until) {
    // Something the JIT cannot skip.
    x = (x * 1664525 + 1013904223) % 4294967296;
  }
  return x;
}
