/**
 * Canvas example: two OffscreenCanvas surfaces on a dedicated worker,
 * steered over the bus, surviving StrictMode and a "route" change.
 *
 * Things to try:
 * - Move the pointer: the field parts around it and the dot follows.
 * - Switch route: the dot changes colour and heads for a new anchor —
 *   the canvas element itself never remounts.
 * - Flip the tier: `ambient` drops to 30fps and ignores the pointer,
 *   `off` terminates the worker; back to `full` starts a fresh one.
 * - Watch the stats line: p95 per surface, once a second.
 */

import { useEffect, useMemo, useState } from 'react';
import { createBus } from '@palinc/nirnam';
import { CanvasHost, useSurface, useMotionTier } from '@palinc/nirnam/canvas/react';
import { resolveMotionTier, probeMotionCapabilities } from '@palinc/nirnam/canvas';
import type { MotionTier, SurfaceStats, MotionPreference } from '@palinc/nirnam/canvas';

const bus = createBus();

function DotCanvas({ route }: { route: 'login' | 'home' }) {
  const state = useMemo(() => ({ route }), [route]);
  const ref = useSurface('dot', { state });
  return <canvas ref={ref} aria-hidden style={{ position: 'fixed', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }} />;
}

function FieldCanvas() {
  const ref = useSurface('field');
  return <canvas ref={ref} aria-hidden style={{ position: 'fixed', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }} />;
}

function Background({ route }: { route: 'login' | 'home' }) {
  const tier = useMotionTier();
  if (tier === 'off') {
    return <div style={{ position: 'fixed', inset: 0, background: 'radial-gradient(circle at 50% 50%, #1e293b, #0f172a)' }} />;
  }
  return (
    <>
      <FieldCanvas />
      <DotCanvas route={route} />
    </>
  );
}

function LoginPage() {
  return <section style={{ padding: 24 }}><h1>Login</h1><p>The dot sits centre-stage here.</p></section>;
}

function HomePage() {
  return <section style={{ padding: 24 }}><h1>Home</h1><p>…and moves off to the top-right when you arrive.</p></section>;
}

export default function App() {
  const [route, setRoute] = useState<'login' | 'home'>('login');
  const [preference, setPreference] = useState<MotionPreference>('auto');
  const [stats, setStats] = useState<SurfaceStats[]>([]);
  const [steppedDown, setSteppedDown] = useState<string | null>(null);
  const [pong, setPong] = useState<string>('');
  const caps = useMemo(() => probeMotionCapabilities(), []);
  const tier: MotionTier = resolveMotionTier(caps, preference);

  useEffect(() => { bus.publish('example:route', route); }, [route]);

  return (
    <CanvasHost
      worker={() => new Worker(new URL('./dot.worker.ts', import.meta.url), { type: 'module' })}
      tier={tier}
      bus={bus}
      onStats={setStats}
      onTierChange={(t, reason) => setSteppedDown(`orchestrator stepped down to ${t} (${reason})`)}
    >
      <Background route={route} />
      <div style={{ position: 'relative', zIndex: 1 }}>
        <nav style={{ display: 'flex', gap: 12, padding: 16, alignItems: 'center', background: 'rgba(15,23,42,0.6)' }}>
          <button onClick={() => setRoute('login')} disabled={route === 'login'}>Login</button>
          <button onClick={() => setRoute('home')} disabled={route === 'home'}>Home</button>
          <span style={{ marginLeft: 'auto' }}>Ambient effects:</span>
          {(['auto', 'on', 'off'] as MotionPreference[]).map(p => (
            <button key={p} onClick={() => setPreference(p)} disabled={preference === p}>{p}</button>
          ))}
          <code>tier={tier}</code>
        </nav>
        {route === 'login' ? <LoginPage /> : <HomePage />}
        <footer style={{ padding: 16, fontSize: 12, color: '#94a3b8' }}>
          <div>caps: offscreen={String(caps.offscreenCanvas)} reducedMotion={String(caps.reducedMotion)} finePointer={String(caps.finePointer)} lowEnd={String(caps.lowEnd)}</div>
          <div>{stats.map(s => `${s.surfaceId}: ${s.frames}f p50=${s.p50.toFixed(2)}ms p95=${s.p95.toFixed(2)}ms over=${s.over}`).join(' · ') || 'no stats yet'}</div>
          {steppedDown && <div style={{ color: '#fbbf24' }}>{steppedDown}</div>}
          <button style={{ marginTop: 8 }} onClick={() => bus.request<null, string>('example:ping', null).then(setPong)}>ping the worker over the bus</button>
          {pong && <span style={{ marginLeft: 8 }}>{pong}</span>}
        </footer>
      </div>
    </CanvasHost>
  );
}
