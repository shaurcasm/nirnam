/**
 * Benchmark: Nirnam against the plain alternative, three use cases, same
 * workloads. Numbers on three tabs, effort on the fourth. See README.md
 * for what each column means and RESULTS.md for recorded runs.
 */

import { useEffect, useState } from 'react';
import { TransportTab } from './transport/TransportTab';
import { McpTab } from './mcp/McpTab';
import { CanvasTab } from './canvas/CanvasTab';
import { EffortTab } from './effort/EffortTab';

const TABS = [
  { id: 'transport', label: 'Transport', view: <TransportTab /> },
  { id: 'mcp', label: 'MCP', view: <McpTab /> },
  { id: 'canvas', label: 'Canvas', view: <CanvasTab /> },
  { id: 'effort', label: 'Effort', view: <EffortTab /> },
] as const;

type TabId = (typeof TABS)[number]['id'];

function useHidden() {
  const [hidden, setHidden] = useState(document.visibilityState === 'hidden');
  useEffect(() => {
    const onChange = () => setHidden(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  return hidden;
}

export default function App() {
  const [tab, setTab] = useState<TabId>(() => (location.hash.slice(1) as TabId) || 'transport');
  const hidden = useHidden();
  const select = (id: TabId) => {
    setTab(id);
    location.hash = id;
  };
  return (
    <div style={{ position: 'relative', zIndex: 1, padding: '16px 24px 40px' }}>
      <header style={{ display: 'flex', gap: 12, alignItems: 'baseline', marginBottom: 16, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0, fontSize: 20 }}>Nirnam — with and without</h1>
        <nav style={{ display: 'flex', gap: 8, marginLeft: 12 }}>
          {TABS.map(t => (
            <button key={t.id} onClick={() => select(t.id)} disabled={tab === t.id}>
              {t.label}
            </button>
          ))}
        </nav>
        <span className="muted" style={{ marginLeft: 'auto', fontSize: 12 }}>
          {navigator.hardwareConcurrency} cores · dpr {window.devicePixelRatio}
        </span>
      </header>
      {hidden && (
        <p className="lose" style={{ margin: '0 0 12px' }}>
          This tab is hidden: the browser clamps timers to one a second and stops requestAnimationFrame, so loop lag, fps and the canvas are
          not measurable until it is in front.
        </p>
      )}
      {/* Every tab stays mounted so a run's results survive a look at another tab. */}
      {TABS.map(t => (
        <div key={t.id} hidden={tab !== t.id}>
          {t.view}
        </div>
      ))}
    </div>
  );
}
