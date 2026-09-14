import { describe, it, expect, vi } from 'vitest';
import { eventLoopLag, mainFps, longFrames, busyMeter, typingLatency } from './probes';

/** A clock and timer queue stepped by hand. */
function fakeTime() {
  let now = 0;
  const timers: Array<{ at: number; cb: () => void }> = [];
  const frames: Array<(t: number) => void> = [];
  return {
    now: () => now,
    setTimeout: (cb: () => void, ms: number) => {
      timers.push({ at: now + ms, cb });
      return timers.length;
    },
    clearTimeout: () => {},
    requestFrame: (cb: (t: number) => void) => {
      frames.push(cb);
      return frames.length;
    },
    cancelFrame: () => {},
    /** Advance the clock; run timers that came due, in order, then one frame. */
    advance(ms: number) {
      now += ms;
      timers.sort((a, b) => a.at - b.at);
      while (timers.length && timers[0].at <= now) timers.shift()!.cb();
      const due = frames.splice(0);
      due.forEach(cb => cb(now));
    },
  };
}

describe('eventLoopLag', () => {
  it('measures how late each tick fired beyond its interval', () => {
    const t = fakeTime();
    const stop = eventLoopLag({ intervalMs: 20, ...t });
    t.advance(20); // on time → 0
    t.advance(35); // 15 late
    t.advance(20); // on time
    const s = stop();
    expect(s.n).toBe(3);
    expect(s.max).toBe(15);
    expect(s.p50).toBe(0);
  });
  it('reports nothing if stopped before a tick', () => {
    const t = fakeTime();
    expect(eventLoopLag({ intervalMs: 20, ...t })().n).toBe(0);
  });
});

describe('mainFps', () => {
  it('turns frame intervals into fps percentiles, p5 being the slow tail', () => {
    const t = fakeTime();
    const stop = mainFps(t);
    t.advance(0); // first frame: sets the baseline
    for (let i = 0; i < 9; i++) t.advance(16);
    t.advance(100); // one hitch
    const r = stop();
    expect(r.frames).toBe(10);
    expect(r.fpsMedian).toBeCloseTo(62.5, 0);
    expect(r.fpsP5).toBeCloseTo(10, 0);
    expect(r.intervalMax).toBe(100);
  });
});

describe('longFrames', () => {
  it('counts entries, sums blocking time and keeps script blame', () => {
    let callback: ((list: { getEntries(): unknown[] }) => void) | null = null;
    class FakeObserver {
      static supportedEntryTypes = ['long-animation-frame'];
      constructor(cb: (list: { getEntries(): unknown[] }) => void) {
        callback = cb;
      }
      observe = vi.fn();
      disconnect = vi.fn();
    }
    const stop = longFrames({ PerformanceObserver: FakeObserver as unknown as typeof PerformanceObserver });
    callback!({
      getEntries: () => [
        { duration: 80, blockingDuration: 30, scripts: [{ sourceURL: 'a.js', duration: 70 }] },
        { duration: 60, blockingDuration: 10, scripts: [] },
      ],
    });
    const r = stop();
    expect(r.count).toBe(2);
    expect(r.blockingMs).toBe(40);
    expect(r.scriptless).toBe(1);
    expect(r.blame).toEqual(['a.js 70ms']);
  });
  it('is inert without a PerformanceObserver', () => {
    const r = longFrames({ PerformanceObserver: undefined })();
    expect(r).toEqual({ count: 0, blockingMs: 0, scriptless: 0, blame: [], supported: false });
  });
});

describe('busyMeter', () => {
  it('adds up the time spent inside measured calls', () => {
    const t = fakeTime();
    const meter = busyMeter(t.now);
    meter.measure(() => t.advance(3));
    meter.measure(() => t.advance(5));
    expect(meter.total()).toBe(8);
    expect(meter.calls()).toBe(2);
  });
});

describe('typingLatency', () => {
  it('pairs each keystroke with the commit that followed it', () => {
    const t = fakeTime();
    const probe = typingLatency(t.now);
    probe.pressed();
    t.advance(7);
    probe.committed();
    probe.pressed();
    t.advance(2);
    probe.committed();
    // A commit with no keystroke pending is ignored.
    probe.committed();
    const s = probe.stop();
    expect(s.n).toBe(2);
    expect(s.max).toBe(7);
  });
});
