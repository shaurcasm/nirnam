import { describe, it, expect } from 'vitest';
import { percentile, summarise, medianOf, formatMetric, type Metrics } from './stats';

describe('percentile', () => {
  it('is 0 for no samples', () => {
    expect(percentile([], 0.5)).toBe(0);
  });
  it('takes the nearest-rank value of a sorted list', () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(sorted, 0.5)).toBe(5);
    expect(percentile(sorted, 0.95)).toBe(10);
    expect(percentile(sorted, 0.05)).toBe(1);
    expect(percentile(sorted, 1)).toBe(10);
  });
});

describe('summarise', () => {
  it('reports count, percentiles, mean and max, sorting for itself', () => {
    const s = summarise([5, 1, 3, 2, 4]);
    expect(s.n).toBe(5);
    expect(s.p50).toBe(3);
    expect(s.p95).toBe(5);
    expect(s.max).toBe(5);
    expect(s.mean).toBe(3);
  });
  it('is all zeros for no samples', () => {
    expect(summarise([])).toEqual({ n: 0, p50: 0, p95: 0, max: 0, mean: 0 });
  });
});

describe('medianOf', () => {
  it('takes the median of each metric across runs, keeping every key seen', () => {
    const runs: Metrics[] = [
      { wall: 10, p95: 1 },
      { wall: 30, p95: 3 },
      { wall: 20, p95: 2, extra: 7 },
    ];
    expect(medianOf(runs)).toEqual({ wall: 20, p95: 2, extra: 7 });
  });
  it('averages the middle pair for an even number of runs', () => {
    expect(medianOf([{ a: 1 }, { a: 3 }])).toEqual({ a: 2 });
  });
  it('is empty for no runs', () => {
    expect(medianOf([])).toEqual({});
  });
});

describe('formatMetric', () => {
  it('formats milliseconds with two decimals under 10 and one above', () => {
    expect(formatMetric('lat.p50', 0.1234)).toBe('0.12 ms');
    expect(formatMetric('wall', 123.456)).toBe('123.5 ms');
  });
  it('formats counts and rates without units', () => {
    expect(formatMetric('longFrames', 3)).toBe('3');
    expect(formatMetric('throughput', 12345.6)).toBe('12,346 /s');
    expect(formatMetric('fps.p5', 58.7)).toBe('58.7 fps');
  });
});
