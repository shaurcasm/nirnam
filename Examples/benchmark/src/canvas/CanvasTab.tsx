import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CanvasHost, useSurface } from '@palinc/nirnam/canvas/react';
import type { SurfaceStats } from '@palinc/nirnam/canvas';
import type { Case } from '../harness/runner';
import { ResultsTable } from '../harness/ResultsTable';
import { useRunner } from '../harness/useRunner';
import { RunBar, ParamField } from '../ui';
import { CANVAS_ARMS, type CanvasArm } from './arms';
import { DEFAULT_CANVAS_PARAMS, runCanvasWorkload, type CanvasHarness, type CanvasParams } from './workload';

/** The full-viewport canvas behind the page, at 1x — nobody sees the second pixel. */
function StripCanvas({ strips, variant }: { strips: number; variant: number }) {
  const state = useMemo(() => ({ strips: { strips, variant } }), [strips, variant]);
  const ref = useSurface('background', { state, maxDpr: 1 });
  return <canvas ref={ref} aria-hidden style={{ position: 'fixed', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 0 }} />;
}

const ROWS = Array.from({ length: 400 }, (_, i) => `Row ${i} · ${(i * 7919).toString(36)} · ${['for', 'against', 'undecided'][i % 3]}`);

/**
 * What the keystrokes land in: a controlled input and a list filtered by
 * it — enough of a render to be worth measuring, as a search box over a
 * feed would be. The layout effect fires when the commit for a value has
 * happened, which is when the keystroke was "answered".
 */
function TypingTarget({ inputRef, onCommit }: { inputRef: React.RefObject<HTMLInputElement>; onCommit: () => void }) {
  const [value, setValue] = useState('');
  useLayoutEffect(() => {
    onCommit();
  }, [value, onCommit]);
  const needle = value.slice(-1).toLowerCase();
  const rows = needle ? ROWS.filter(r => r.toLowerCase().includes(needle)) : ROWS;
  return (
    <div style={{ position: 'relative', zIndex: 1, background: 'rgba(15,23,42,0.75)', padding: 12, borderRadius: 8, maxWidth: 520 }}>
      <input
        ref={inputRef}
        value={value}
        onChange={e => setValue(e.target.value)}
        placeholder="the benchmark types here — or you can"
        style={{ width: '100%', font: 'inherit', padding: 6, background: '#1e293b', color: '#e5e7eb', border: '1px solid #334155', borderRadius: 4 }}
      />
      <ul style={{ margin: '8px 0 0', padding: 0, listStyle: 'none', maxHeight: 220, overflow: 'auto', fontSize: 12 }}>
        {rows.map(r => (
          <li key={r} style={{ padding: '2px 0', borderBottom: '1px solid #1e293b' }}>
            {r}
          </li>
        ))}
      </ul>
    </div>
  );
}

const nativeValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;

export function CanvasTab() {
  const [params, setParams] = useState<CanvasParams>(DEFAULT_CANVAS_PARAMS);
  const [active, setActive] = useState<CanvasArm | null>(null);
  const [variant, setVariant] = useState(0);
  const [live, setLive] = useState<SurfaceStats[]>([]);
  const statsRef = useRef<SurfaceStats[]>([]);
  const readyRef = useRef<(() => void) | null>(null);
  const commitListeners = useRef(new Set<() => void>());
  const inputRef = useRef<HTMLInputElement>(null);
  const typed = useRef(0);
  const { results, running, progress, start, abort } = useRunner('canvas');

  const onStats = useCallback((stats: SurfaceStats[]) => {
    statsRef.current.push(...stats);
    setLive(stats);
    if (readyRef.current && stats.some(s => s.frames > 0)) {
      readyRef.current();
      readyRef.current = null;
    }
  }, []);

  const onCommit = useCallback(() => commitListeners.current.forEach(l => l()), []);

  const harnessFor = (arm: CanvasArm): CanvasHarness => ({
    mount: () =>
      new Promise<void>((resolve, reject) => {
        statsRef.current = [];
        readyRef.current = resolve;
        setActive(arm);
        setTimeout(() => {
          if (readyRef.current === resolve) {
            readyRef.current = null;
            reject(new Error('surface never reported frames — is the tab visible?'));
          }
        }, 10000);
      }),
    unmount: async () => {
      setActive(null);
      await new Promise(r => setTimeout(r, 300));
    },
    type: () => {
      const el = inputRef.current;
      if (!el) return;
      nativeValueSetter.call(el, `${el.value.slice(-24)}${'abcdefghij'[typed.current++ % 10]}`);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    },
    onCommit: listener => {
      commitListeners.current.add(listener);
      return () => commitListeners.current.delete(listener);
    },
    stats: () => statsRef.current,
  });

  const cases: Case[] = CANVAS_ARMS.map(arm => ({
    arm: arm.id,
    armLabel: arm.label,
    workload: 'typing',
    workloadLabel: `Typing over the animation — ${params.strips} strips/frame, ${params.durationMs / 1000}s, a keystroke every ${params.keyEveryMs} ms`,
    run: () => runCanvasWorkload(harnessFor(arm), params),
  }));

  return (
    <section>
      <p className="muted" style={{ maxWidth: 820 }}>
        A surface shaped like Wevaad's trees — six bitmaps painted once, drawn every frame as swaying strips — on a worker, and the very same
        surface and orchestrator on the main thread through <code>inlineWorker</code>. Over it, the benchmark types into a filtered list and
        measures each keystroke to its commit. Both arms report frames drawn, so you can see they did the same work. The tab must be
        visible: a hidden page draws nothing, on purpose.
      </p>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 12, alignItems: 'flex-end' }}>
        <ParamField label="strips / frame" value={params.strips} step={50} onChange={v => setParams({ ...params, strips: v })} />
        <ParamField label="duration ms" value={params.durationMs} step={1000} onChange={v => setParams({ ...params, durationMs: v })} />
        <ParamField label="keystroke every ms" value={params.keyEveryMs} step={10} onChange={v => setParams({ ...params, keyEveryMs: v })} />
        <span className="muted" style={{ fontSize: 12 }}>
          look, without measuring:{' '}
          {CANVAS_ARMS.map(arm => (
            <button key={arm.id} disabled={running || active?.id === arm.id} onClick={() => setActive(arm)} style={{ marginLeft: 4 }}>
              {arm.id}
            </button>
          ))}
          <button disabled={running || !active} onClick={() => setActive(null)} style={{ marginLeft: 4 }}>
            hide
          </button>
          <button disabled={!active} onClick={() => setVariant(v => v + 1)} style={{ marginLeft: 4 }}>
            repaint
          </button>
        </span>
      </div>
      <RunBar running={running} progress={progress} onRun={() => start(cases)} onAbort={abort} />
      {active && (
        <CanvasHost key={active.id} worker={active.createWorker} tier="full" onStats={onStats}>
          <StripCanvas strips={params.strips} variant={variant} />
        </CanvasHost>
      )}
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: 16 }}>
        <TypingTarget inputRef={inputRef} onCommit={onCommit} />
        {active && (
          <div className="muted" style={{ fontSize: 12, position: 'relative', zIndex: 1 }}>
            <div>
              <strong>{active.label}</strong> — {active.note}
            </div>
            <div>
              {live.map(s => `${s.surfaceId}: ${s.frames}f p50=${s.p50.toFixed(2)}ms p95=${s.p95.toFixed(2)}ms over=${s.over}${s.events.map(e => ` ${e.name}×${e.count} ${e.ms.toFixed(0)}ms`).join('')}`).join(' · ') || 'no stats yet'}
            </div>
          </div>
        )}
      </div>
      <ResultsTable results={results} />
    </section>
  );
}
