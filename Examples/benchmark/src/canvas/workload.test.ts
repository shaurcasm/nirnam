import { describe, it, expect } from 'vitest';
import { summariseSurfaceStats } from './workload';

describe('summariseSurfaceStats', () => {
  it('totals frames and over-budget frames, takes the median p95, and sums rebuild events by name suffix', () => {
    const m = summariseSurfaceStats([
      { surfaceId: 'background', frames: 30, p50: 1, p95: 2, over: 0, events: [{ name: 'strips:rebuild', count: 1, ms: 40 }] },
      { surfaceId: 'background', frames: 30, p50: 1, p95: 6, over: 3, events: [] },
      { surfaceId: 'background', frames: 30, p50: 1, p95: 4, over: 1, events: [{ name: 'strips:rebuild', count: 2, ms: 60 }] },
    ]);
    expect(m['surface.frames']).toBe(90);
    expect(m['surface.over']).toBe(4);
    expect(m['surface.p95']).toBe(4);
    expect(m['rebuild.count']).toBe(3);
    expect(m['rebuild.ms']).toBe(100);
  });

  it('ignores intervals with no frames when taking the p95 median', () => {
    const m = summariseSurfaceStats([
      { surfaceId: 'background', frames: 0, p50: 0, p95: 0, over: 0, events: [] },
      { surfaceId: 'background', frames: 10, p50: 1, p95: 3, over: 0, events: [] },
    ]);
    expect(m['surface.p95']).toBe(3);
  });
});
