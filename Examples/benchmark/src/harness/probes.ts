/**
 * Main-thread probes. Each one starts on creation and returns a `stop()`
 * that reports what it saw. Every browser dependency is injectable so the
 * arithmetic can be tested in Node.
 *
 * - `eventLoopLag`: a timer chain; how late each tick fired is how busy the
 *   thread was. The closest thing to "would a click have waited" that does
 *   not need a real click.
 * - `mainFps`: the page's own requestAnimationFrame cadence — what a CSS
 *   transition or a scroll would have got.
 * - `longFrames`: `long-animation-frame` entries with script blame, the same
 *   signal Wevaad's vitals recorder reads.
 * - `busyMeter`: time spent inside the handlers we wrap — the cost the
 *   transport itself puts on this thread.
 * - `typingLatency`: keystroke → React commit, an INP proxy for a synthetic
 *   keystroke (a real INP needs a real input).
 */

import { summarise, type Summary } from './stats';

interface Timers {
  now(): number;
  setTimeout(cb: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

const browserTimers = (): Timers => ({
  now: () => performance.now(),
  setTimeout: (cb, ms) => setTimeout(cb, ms) as unknown as number,
  clearTimeout: id => clearTimeout(id),
});

export function eventLoopLag(options: Partial<Timers> & { intervalMs?: number } = {}): () => Summary {
  const { intervalMs = 25 } = options;
  const t = { ...browserTimers(), ...options };
  const samples: number[] = [];
  let stopped = false;
  let expected = t.now() + intervalMs;
  let id = 0;
  const tick = () => {
    if (stopped) return;
    const now = t.now();
    samples.push(Math.max(0, now - expected));
    expected = now + intervalMs;
    id = t.setTimeout(tick, intervalMs);
  };
  id = t.setTimeout(tick, intervalMs);
  return () => {
    stopped = true;
    t.clearTimeout(id);
    return summarise(samples);
  };
}

interface Frames {
  now(): number;
  requestFrame(cb: (t: number) => void): number;
  cancelFrame(id: number): void;
}

export interface FpsResult {
  frames: number;
  fpsMedian: number;
  /** The slow tail: 1000 / the 95th-percentile interval. */
  fpsP5: number;
  intervalMax: number;
}

export function mainFps(options: Partial<Frames> = {}): () => FpsResult {
  const f: Frames = {
    now: () => performance.now(),
    requestFrame: cb => requestAnimationFrame(cb),
    cancelFrame: id => cancelAnimationFrame(id),
    ...options,
  };
  const intervals: number[] = [];
  let last: number | null = null;
  let id = 0;
  let stopped = false;
  const onFrame = (time: number) => {
    if (stopped) return;
    if (last !== null) intervals.push(time - last);
    last = time;
    id = f.requestFrame(onFrame);
  };
  id = f.requestFrame(onFrame);
  return () => {
    stopped = true;
    f.cancelFrame(id);
    const s = summarise(intervals);
    return {
      frames: s.n,
      fpsMedian: s.p50 > 0 ? 1000 / s.p50 : 0,
      fpsP5: s.p95 > 0 ? 1000 / s.p95 : 0,
      intervalMax: s.max,
    };
  };
}

export interface LongFramesResult {
  count: number;
  blockingMs: number;
  /** Entries with no script attribution: layout, paint, the compositor waiting on a canvas. */
  scriptless: number;
  /** The longest script of each entry, `source duration`. */
  blame: string[];
  supported: boolean;
}

interface LoAFEntry {
  duration: number;
  blockingDuration?: number;
  scripts?: Array<{ sourceURL?: string; invoker?: string; duration?: number }>;
}

export function longFrames(options: { PerformanceObserver?: typeof PerformanceObserver } = {}): () => LongFramesResult {
  const PO = 'PerformanceObserver' in options ? options.PerformanceObserver : globalThis.PerformanceObserver;
  const supported = !!PO && (PO.supportedEntryTypes ?? []).includes('long-animation-frame');
  const result: LongFramesResult = { count: 0, blockingMs: 0, scriptless: 0, blame: [], supported };
  if (!supported) return () => result;
  const observer = new PO!(list => {
    (list.getEntries() as unknown as LoAFEntry[]).forEach(entry => {
      result.count += 1;
      result.blockingMs += entry.blockingDuration ?? 0;
      const scripts = entry.scripts ?? [];
      if (scripts.length === 0) result.scriptless += 1;
      const worst = scripts.slice().sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0))[0];
      if (worst) result.blame.push(`${worst.sourceURL || worst.invoker || '?'} ${Math.round(worst.duration ?? 0)}ms`);
    });
  });
  observer.observe({ type: 'long-animation-frame', buffered: false } as PerformanceObserverInit);
  return () => {
    observer.disconnect();
    return result;
  };
}

export interface BusyMeter {
  measure<T>(fn: () => T): T;
  total(): number;
  calls(): number;
}

export function busyMeter(now: () => number = () => performance.now()): BusyMeter {
  let total = 0;
  let calls = 0;
  return {
    measure(fn) {
      const before = now();
      try {
        return fn();
      } finally {
        total += now() - before;
        calls += 1;
      }
    },
    total: () => total,
    calls: () => calls,
  };
}

export interface TypingProbe {
  pressed(): void;
  committed(): void;
  stop(): Summary;
}

export function typingLatency(now: () => number = () => performance.now()): TypingProbe {
  const samples: number[] = [];
  let pending: number | null = null;
  return {
    pressed() {
      pending = now();
    },
    committed() {
      if (pending === null) return;
      samples.push(now() - pending);
      pending = null;
    },
    stop: () => summarise(samples),
  };
}
