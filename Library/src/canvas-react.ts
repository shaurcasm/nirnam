/**
 * @palinc/nirnam/canvas/react
 *
 * React binding over `CanvasHostController`.
 *
 *   <CanvasHost worker={() => new Worker(new URL('./ambient.worker', import.meta.url), { type: 'module' })}
 *               tier={tier} bus={bus} onStats={record}>
 *     <TreeBackground />
 *   </CanvasHost>
 *
 *   function TreeBackground() {
 *     const ref = useSurface('tree', { state: { anchor } });
 *     return <canvas ref={ref} aria-hidden style={{ position: 'fixed', inset: 0, pointerEvents: 'none' }} />;
 *   }
 *
 * Under the `off` tier nothing is started: no worker, no transfers.
 * `useSurface` still returns a ref, so a component can render its canvas
 * unconditionally, or read `useMotionTier()` and render a static fallback.
 */

import * as React from 'react';
import { CanvasHostController } from './canvas/host';
import type { SurfaceHandle } from './canvas/host';
import type { MotionTier, OrchestratorMessage, SurfaceStats } from './canvas/types';

interface HostContextValue {
  controller: CanvasHostController | null;
  tier: MotionTier;
}

const HostContext = React.createContext<HostContextValue>({ controller: null, tier: 'off' });

export interface CanvasHostProps {
  /** Creates the worker running `createOrchestrator`. Called once per non-`off` tier session. */
  worker: () => Worker;
  tier: MotionTier;
  /** When given, the worker joins the bus via `adoptWorker` before anything else. Structural, so any bus build matches. */
  bus?: { adoptWorker(worker: Worker): { release(): void } };
  onStats?: (stats: SurfaceStats[], tier: MotionTier) => void;
  /** The orchestrator stepped itself down; the consumer usually mirrors this into its own tier state. */
  onTierChange?: (tier: MotionTier, reason?: 'over-budget') => void;
  children?: React.ReactNode;
}

export function CanvasHost(props: CanvasHostProps): React.ReactElement {
  const { worker: createWorker, tier, bus, onStats, onTierChange, children } = props;
  const [controller, setController] = React.useState<CanvasHostController | null>(null);
  // Latest props, read from inside the effect so an inline arrow for any of
  // them does not tear the worker down on every render.
  const createWorkerRef = React.useRef(createWorker);
  const statsRef = React.useRef(onStats);
  const tierChangeRef = React.useRef(onTierChange);
  const tierRef = React.useRef(tier);
  createWorkerRef.current = createWorker;
  statsRef.current = onStats;
  tierChangeRef.current = onTierChange;
  tierRef.current = tier;

  // One worker per span of non-off tiers. Flipping to `off` and back gets a fresh one.
  const active = tier !== 'off';
  React.useEffect(() => {
    if (!active) {
      setController(null);
      return;
    }
    const worker = createWorkerRef.current();
    const adoption = bus?.adoptWorker(worker);
    const next = new CanvasHostController(
      {
        post: (message, transfer) => worker.postMessage(message, transfer ?? []),
        onMessage: (listener) => {
          const handler = (event: MessageEvent) => {
            const data = event.data as OrchestratorMessage | null;
            if (data && typeof data === 'object' && String(data.type).startsWith('canvas:')) listener(data);
          };
          worker.addEventListener('message', handler);
          return () => worker.removeEventListener('message', handler);
        },
        ResizeObserver: typeof ResizeObserver !== 'undefined' ? ResizeObserver : undefined,
        IntersectionObserver: typeof IntersectionObserver !== 'undefined' ? IntersectionObserver : undefined,
      },
      { tier: tierRef.current },
    );
    const offStats = next.onStats((stats, t) => statsRef.current?.(stats, t));
    const offTier = next.onTierChange((t, reason) => tierChangeRef.current?.(t, reason));
    setController(next);
    return () => {
      offStats();
      offTier();
      next.dispose();
      // Leave the hub before dying: a terminated worker's port does not
      // close by itself, and a dead participant would still be routed to.
      adoption?.release();
      worker.terminate();
      setController(null);
    };
  }, [active, bus]);

  React.useEffect(() => {
    controller?.setTier(tier);
  }, [controller, tier]);

  const value = React.useMemo<HostContextValue>(() => ({ controller, tier }), [controller, tier]);
  return React.createElement(HostContext.Provider, { value }, children);
}

/** The tier the nearest `CanvasHost` is running at. */
export function useMotionTier(): MotionTier {
  return React.useContext(HostContext).tier;
}

export interface UseSurfaceOptions<State> {
  /** Sent on attach and whenever it changes (by reference). */
  state?: State;
}

/**
 * Attach a `<canvas>` to a surface the orchestrator knows by this id. Returns
 * a callback ref for the element. Survives StrictMode's double mount; the
 * element is transferred once.
 */
export function useSurface<State = unknown>(surfaceId: string, options: UseSurfaceOptions<State> = {}): (canvas: HTMLCanvasElement | null) => void {
  const { controller } = React.useContext(HostContext);
  const [canvas, setCanvas] = React.useState<HTMLCanvasElement | null>(null);
  const handleRef = React.useRef<SurfaceHandle | null>(null);
  const stateRef = React.useRef(options.state);
  const sentRef = React.useRef<State | undefined>(undefined);
  stateRef.current = options.state;

  React.useEffect(() => {
    if (!controller || !canvas) return;
    const handle = controller.attach(surfaceId, canvas, stateRef.current);
    sentRef.current = stateRef.current;
    handleRef.current = handle;
    return () => {
      handle.detach();
      handleRef.current = null;
    };
  }, [controller, canvas, surfaceId]);

  const { state } = options;
  React.useEffect(() => {
    if (state === undefined || state === sentRef.current) return;
    sentRef.current = state;
    handleRef.current?.setState(state);
  }, [state]);

  return React.useCallback((element: HTMLCanvasElement | null) => setCanvas(element), []);
}

export type { MotionTier, SurfaceStats } from './canvas/types';
