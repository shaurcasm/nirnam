/**
 * Pure numbers: percentiles, summaries, the median across repetitions, and
 * how a metric is printed. Nothing here touches a browser.
 */

export interface Summary {
  n: number;
  p50: number;
  p95: number;
  max: number;
  mean: number;
}

/** Nearest-rank percentile of an already sorted list. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank))];
}

export function summarise(samples: number[]): Summary {
  if (samples.length === 0) return { n: 0, p50: 0, p95: 0, max: 0, mean: 0 };
  const sorted = samples.slice().sort((a, b) => a - b);
  const sum = sorted.reduce((s, v) => s + v, 0);
  return {
    n: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1],
    mean: sum / sorted.length,
  };
}

/** A flat bag of metrics for one run. Keys are dotted: `lat.p50`, `fps.p5`. */
export type Metrics = Record<string, number>;

/** Per-metric median across repetitions — the number a result table shows. */
export function medianOf(runs: Metrics[]): Metrics {
  const keys = new Set<string>();
  runs.forEach(run => Object.keys(run).forEach(k => keys.add(k)));
  const out: Metrics = {};
  keys.forEach(key => {
    const values = runs.map(r => r[key]).filter((v): v is number => typeof v === 'number').sort((a, b) => a - b);
    if (values.length === 0) return;
    const mid = Math.floor(values.length / 2);
    out[key] = values.length % 2 === 1 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
  });
  return out;
}

/** How a metric prints, from its name: counts, rates and fps are unitless or so; the rest are milliseconds. */
export function formatMetric(key: string, value: number): string {
  const leaf = key.split('.').pop() ?? key;
  if (key.startsWith('fps')) return `${value.toFixed(1)} fps`;
  if (key === 'throughput') return `${Math.round(value).toLocaleString('en-US')} /s`;
  if (leaf === 'count' || leaf === 'n' || key === 'longFrames' || key === 'over' || key === 'frames') return `${Math.round(value)}`;
  return value < 10 ? `${value.toFixed(2)} ms` : `${value.toFixed(1)} ms`;
}
