/** Small shared controls. */

import type { Case } from './harness/runner';

export function ParamField({ label, value, onChange, step = 1 }: { label: string; value: number; onChange: (v: number) => void; step?: number }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12 }} className="muted">
      {label}
      <input
        type="number"
        value={value}
        step={step}
        min={0}
        onChange={e => onChange(Number(e.target.value))}
        style={{ width: 90, font: 'inherit', background: '#1e293b', color: '#e5e7eb', border: '1px solid #334155', borderRadius: 4, padding: 3 }}
      />
    </label>
  );
}

export function RunBar({
  running,
  progress,
  onRun,
  onAbort,
}: {
  running: boolean;
  progress: { done: number; total: number; current: Case | null } | null;
  onRun: () => void;
  onAbort: () => void;
}) {
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 16 }}>
      <button className="primary" onClick={onRun} disabled={running}>
        {running ? 'running…' : 'Run'}
      </button>
      {running && <button onClick={onAbort}>abort</button>}
      {progress && (
        <span className="muted">
          {progress.done} / {progress.total}
          {progress.current && ` — ${progress.current.armLabel} · ${progress.current.workloadLabel}`}
        </span>
      )}
    </div>
  );
}
