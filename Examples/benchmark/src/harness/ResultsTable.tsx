/**
 * One table per workload: a row per arm, a column per metric, values
 * formatted by name. Below it, the run as JSON — copy it into RESULTS.md
 * with the machine it came from.
 */

import { useMemo, useState } from 'react';
import type { CaseResult } from './runner';
import { formatMetric } from './stats';

/** The order columns appear in, when present; anything else follows alphabetically. */
const PREFERRED = ['wall', 'throughput', 'lat.p50', 'lat.p95', 'lat.max', 'gap.p50', 'gap.p95', 'busyMs', 'busyPer1k', 'typing.p50', 'typing.p95', 'typing.max', 'keystrokes', 'lag.p50', 'lag.p95', 'lag.max', 'fps.median', 'fps.p5', 'longFrames', 'blockingMs', 'surface.frames', 'surface.p95', 'surface.over', 'rebuild.count', 'rebuild.ms'];

const LABELS: Record<string, string> = {
  wall: 'wall',
  throughput: 'rate',
  'lat.p50': 'latency p50',
  'lat.p95': 'latency p95',
  'lat.max': 'latency max',
  'gap.p50': 'chunk gap p50',
  'gap.p95': 'chunk gap p95',
  busyMs: 'main busy',
  busyPer1k: 'main busy / 1k',
  'typing.p50': 'keystroke→commit p50',
  'typing.p95': 'keystroke→commit p95',
  'typing.max': 'keystroke→commit max',
  keystrokes: 'keystrokes',
  'lag.p50': 'loop lag p50',
  'lag.p95': 'loop lag p95',
  'lag.max': 'loop lag max',
  'fps.median': 'main fps median',
  'fps.p5': 'main fps p5',
  longFrames: 'long frames',
  blockingMs: 'blocking',
  'surface.frames': 'frames drawn',
  'surface.p95': 'surface p95',
  'surface.over': 'over budget',
  'rebuild.count': 'rebuilds',
  'rebuild.ms': 'rebuild ms',
};

function columnsOf(results: CaseResult[]): string[] {
  const seen = new Set<string>();
  results.forEach(r => Object.keys(r.metrics ?? {}).forEach(k => seen.add(k)));
  const preferred = PREFERRED.filter(k => seen.has(k));
  const rest = [...seen].filter(k => !PREFERRED.includes(k)).sort();
  return [...preferred, ...rest];
}

/** Lower is better for everything but rates, fps, frames and keystrokes. */
const lowerIsBetter = (key: string) => !(key === 'throughput' || key.startsWith('fps') || key === 'surface.frames' || key === 'keystrokes');

export function ResultsTable({ results, notes }: { results: CaseResult[]; notes?: Record<string, string> }) {
  const workloads = useMemo(() => [...new Set(results.map(r => r.workload))], [results]);
  const columns = useMemo(() => columnsOf(results), [results]);
  const [showJson, setShowJson] = useState(false);
  if (results.length === 0) return null;
  const json = JSON.stringify(
    { recorded: new Date().toISOString(), userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency, results },
    null,
    2,
  );
  return (
    <div style={{ display: 'grid', gap: 20 }}>
      {workloads.map(w => {
        const rows = results.filter(r => r.workload === w);
        const cols = columns.filter(c => rows.some(r => r.metrics && c in r.metrics));
        const best: Record<string, number> = {};
        cols.forEach(c => {
          const values = rows.map(r => r.metrics?.[c]).filter((v): v is number => typeof v === 'number');
          if (values.length > 1) best[c] = lowerIsBetter(c) ? Math.min(...values) : Math.max(...values);
        });
        return (
          <div key={w} style={{ overflowX: 'auto' }}>
            <div style={{ marginBottom: 6 }}>
              <strong>{rows[0].workloadLabel}</strong>
              {notes?.[w] && <span className="muted"> — {notes[w]}</span>}
            </div>
            <table>
              <thead>
                <tr>
                  <th>arm</th>
                  {cols.map(c => (
                    <th key={c} title={c}>{LABELS[c] ?? c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.arm}>
                    <td>{r.armLabel}</td>
                    {r.metrics ? (
                      cols.map(c => {
                        const v = r.metrics![c];
                        const isBest = typeof v === 'number' && best[c] === v;
                        return (
                          <td key={c} className={isBest ? 'win' : undefined}>{typeof v === 'number' ? formatMetric(c, v) : ''}</td>
                        );
                      })
                    ) : (
                      <td colSpan={cols.length} className="muted" style={{ textAlign: 'left' }}>
                        {r.error ? `error: ${r.error}` : `— ${r.unsupported}`}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
      <div>
        <button onClick={() => setShowJson(s => !s)}>{showJson ? 'hide JSON' : 'show JSON'}</button>{' '}
        <button onClick={() => navigator.clipboard?.writeText(json)}>copy JSON</button>
        {showJson && <pre style={{ fontSize: 11, maxHeight: 300, overflow: 'auto', background: '#020617', padding: 12 }}>{json}</pre>}
      </div>
    </div>
  );
}
