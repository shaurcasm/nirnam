/**
 * CanvasHostController — the main-thread half of the canvas runtime.
 *
 * Owns the page's side of the protocol: transfers each `<canvas>` to the
 * worker once, keeps the orchestrator told about size, device pixel ratio,
 * visibility and pointer input, and relays stats and self-imposed tier
 * changes back. Framework-free; `@palinc/nirnam/canvas/react` is a thin
 * binding over it.
 *
 * Two things it is careful about:
 *
 * - `transferControlToOffscreen()` is one-shot per element, and React's
 *   StrictMode mounts twice in development. So a detach is deferred by a
 *   task, and attaching the same element again in that window simply
 *   cancels it. The element is transferred exactly once.
 * - Pointer input is batched to one message per surface per frame, and only
 *   under the `full` tier. Forwarding every event would put a task on the
 *   worker for each of the 120+ samples a second a good mouse produces.
 */

import type { HostMessage, MotionTier, OrchestratorMessage, PointerSample, SurfaceStats } from './types';
import { sameValue } from './sameValue';

/** Everything the controller needs from the page, injectable for tests. */
export interface HostDeps {
  /** Send to the worker — `worker.postMessage`. */
  post(message: HostMessage, transfer?: Transferable[]): void;
  /** Listen to the worker; returns an unsubscribe. */
  onMessage(listener: (message: OrchestratorMessage) => void): () => void;
  transfer?(canvas: HTMLCanvasElement): OffscreenCanvas;
  ResizeObserver?: typeof ResizeObserver;
  IntersectionObserver?: typeof IntersectionObserver;
  /** Where pointer events are read from; `window` so the canvas can stay `pointer-events: none`. */
  pointerTarget?: EventTarget;
  /** Where `visibilitychange` is read from; `document`. */
  visibilityTarget?: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;
  devicePixelRatio?(): number;
  /** Call back whenever the DPR changes; returns an unsubscribe. */
  watchDevicePixelRatio?(callback: () => void): () => void;
  requestFrame?(callback: () => void): number;
  cancelFrame?(id: number): void;
  /** Run after the current task — how a detach waits out a StrictMode remount. */
  defer?(callback: () => void): void;
  now?(): number;
}

export interface HostOptions {
  tier: MotionTier;
}

export interface SurfaceHandle {
  setState(state: unknown): void;
  detach(): void;
}

export interface AttachOptions {
  /**
   * Cap the device pixel ratio this surface is drawn at, below whatever the
   * tier allows. A full-viewport background rarely needs more than 1: the
   * compositor uploads and blends every pixel of it every frame.
   */
  maxDpr?: number;
}

interface Attachment {
  surfaceId: string;
  canvas: HTMLCanvasElement;
  /** The last state sent, so an equal one is not sent again. */
  lastState: { value: unknown } | null;
  /** Position on the page, for pointer offsets. */
  rect: { left: number; top: number; width: number; height: number };
  /** Content box in CSS pixels — what the surface draws into. */
  box: { width: number; height: number };
  maxDpr: number;
  resize: ResizeObserver | null;
  visibility: IntersectionObserver | null;
  detachPending: boolean;
  detached: boolean;
}

interface PointerEventLike {
  clientX: number;
  clientY: number;
  buttons: number;
}

const POINTER_EVENTS = ['pointermove', 'pointerdown', 'pointerup', 'pointercancel'] as const;

/** Browser defaults for everything a test would inject. */
function browserDeps(): Required<Omit<HostDeps, 'post' | 'onMessage' | 'ResizeObserver' | 'IntersectionObserver'>> {
  const g = globalThis as unknown as {
    window?: Window;
    document?: Document;
    devicePixelRatio?: number;
    matchMedia?: (q: string) => MediaQueryList;
    requestAnimationFrame?: (cb: () => void) => number;
    cancelAnimationFrame?: (id: number) => void;
  };
  return {
    transfer: (canvas) => canvas.transferControlToOffscreen(),
    pointerTarget: g.window as unknown as EventTarget,
    visibilityTarget: g.document ?? { visibilityState: 'visible', addEventListener: () => {}, removeEventListener: () => {} },
    devicePixelRatio: () => g.devicePixelRatio ?? 1,
    watchDevicePixelRatio: (callback) => {
      // A media query matching the *current* ratio stops matching when it changes;
      // re-arm after each change so the next one is caught too.
      const { matchMedia } = g;
      if (!matchMedia) return () => {};
      let query: MediaQueryList | null = null;
      const arm = () => {
        query?.removeEventListener('change', onChange);
        query = matchMedia(`(resolution: ${g.devicePixelRatio ?? 1}dppx)`);
        query.addEventListener('change', onChange);
      };
      const onChange = () => {
        arm();
        callback();
      };
      arm();
      return () => query?.removeEventListener('change', onChange);
    },
    requestFrame: (cb) => (g.requestAnimationFrame ?? ((f: () => void) => setTimeout(f, 16) as unknown as number))(cb),
    cancelFrame: (id) => (g.cancelAnimationFrame ?? ((i: number) => clearTimeout(i as unknown as ReturnType<typeof setTimeout>)))(id),
    defer: (cb) => { setTimeout(cb, 0); },
    now: () => performance.now(),
  };
}

export class CanvasHostController {
  private readonly deps: HostDeps & ReturnType<typeof browserDeps>;
  private readonly attachments = new Map<HTMLCanvasElement, Attachment>();
  private readonly statsListeners = new Set<(stats: SurfaceStats[], tier: MotionTier) => void>();
  private readonly tierListeners = new Set<(tier: MotionTier, reason?: 'over-budget') => void>();
  private readonly unsubscribeWorker: () => void;
  private readonly unwatchDpr: () => void;
  private _tier: MotionTier;

  // Pointer state: the latest raw event, resolved per surface at flush time.
  private pointerListening = false;
  private lastPointer: PointerEventLike | null = null;
  private flushId: number | null = null;
  private readonly lastSent = new Map<string, PointerSample>();
  private readonly onPointer = (event: Event) => {
    this.lastPointer = event as unknown as PointerEventLike;
    if (this.flushId === null) this.flushId = this.deps.requestFrame(this.flushPointer);
  };

  constructor(deps: HostDeps, options: HostOptions) {
    this.deps = { ...browserDeps(), ...deps };
    this._tier = options.tier;
    this.unsubscribeWorker = this.deps.onMessage(this.onWorkerMessage);
    this.unwatchDpr = this.deps.watchDevicePixelRatio(this.onDprChange);
    this.deps.post({ type: 'canvas:tier', tier: this._tier });
    this.deps.visibilityTarget.addEventListener('visibilitychange', this.onVisibilityChange);
    if (this.deps.visibilityTarget.visibilityState === 'hidden') this.onVisibilityChange();
    this.syncPointerListening();
  }

  // Worker rAF is not throttled in a background tab; the orchestrator stops on this instead.
  private readonly onVisibilityChange = () => {
    this.deps.post({ type: 'canvas:page-hidden', hidden: this.deps.visibilityTarget.visibilityState === 'hidden' });
  };

  get tier(): MotionTier {
    return this._tier;
  }

  // ---- surfaces --------------------------------------------------------------

  attach(surfaceId: string, canvas: HTMLCanvasElement, state?: unknown, options: AttachOptions = {}): SurfaceHandle {
    let attachment = this.attachments.get(canvas);
    if (attachment?.detachPending) {
      // Same element back within the deferral window — a StrictMode remount.
      attachment.detachPending = false;
    } else {
      attachment = this.create(surfaceId, canvas, options);
    }
    const current = attachment;
    if (state !== undefined) this.sendState(current, state);

    return {
      setState: (next) => {
        if (!current.detached) this.sendState(current, next);
      },
      detach: () => this.scheduleDetach(current),
    };
  }

  /**
   * State goes over as a structured clone, so the orchestrator cannot tell a
   * repeat from a change; the comparison happens here, before the message.
   * A React host re-renders for many reasons that leave the state as it was.
   */
  private sendState(attachment: Attachment, state: unknown): void {
    if (attachment.lastState && sameValue(attachment.lastState.value, state)) return;
    attachment.lastState = { value: state };
    this.deps.post({ type: 'canvas:state', surfaceId: attachment.surfaceId, state });
  }

  private create(surfaceId: string, canvas: HTMLCanvasElement, options: AttachOptions): Attachment {
    const rect = canvas.getBoundingClientRect();
    const attachment: Attachment = {
      surfaceId,
      canvas,
      lastState: null,
      rect,
      box: { width: rect.width, height: rect.height },
      maxDpr: options.maxDpr ?? Infinity,
      resize: null,
      visibility: null,
      detachPending: false,
      detached: false,
    };
    this.attachments.set(canvas, attachment);

    const offscreen = this.deps.transfer(canvas);
    this.deps.post({ type: 'canvas:attach', surfaceId, canvas: offscreen, size: this.sizeOf(attachment) }, [offscreen]);

    if (this.deps.ResizeObserver) {
      attachment.resize = new this.deps.ResizeObserver((entries) => {
        const entry = entries[entries.length - 1];
        attachment.rect = canvas.getBoundingClientRect();
        attachment.box = { width: entry.contentRect.width, height: entry.contentRect.height };
        this.deps.post({ type: 'canvas:resize', surfaceId, size: this.sizeOf(attachment) });
      });
      attachment.resize.observe(canvas);
    }
    if (this.deps.IntersectionObserver) {
      attachment.visibility = new this.deps.IntersectionObserver((entries) => {
        entries.forEach(entry => this.deps.post({ type: 'canvas:visible', surfaceId, visible: entry.isIntersecting }));
      });
      attachment.visibility.observe(canvas);
    }
    return attachment;
  }

  private sizeOf(attachment: Attachment) {
    return {
      width: attachment.box.width,
      height: attachment.box.height,
      dpr: Math.min(this.deps.devicePixelRatio(), attachment.maxDpr),
    };
  }

  private scheduleDetach(attachment: Attachment) {
    if (attachment.detached || attachment.detachPending) return;
    attachment.detachPending = true;
    this.deps.defer(() => {
      if (attachment.detachPending) this.detachNow(attachment);
    });
  }

  private detachNow(attachment: Attachment) {
    attachment.detachPending = false;
    attachment.detached = true;
    attachment.resize?.disconnect();
    attachment.visibility?.disconnect();
    this.attachments.delete(attachment.canvas);
    this.lastSent.delete(attachment.surfaceId);
    this.deps.post({ type: 'canvas:detach', surfaceId: attachment.surfaceId });
  }

  // ---- tier ------------------------------------------------------------------

  setTier(tier: MotionTier): void {
    if (tier === this._tier) return;
    this._tier = tier;
    this.deps.post({ type: 'canvas:tier', tier });
    this.syncPointerListening();
  }

  onTierChange(listener: (tier: MotionTier, reason?: 'over-budget') => void): () => void {
    this.tierListeners.add(listener);
    return () => this.tierListeners.delete(listener);
  }

  onStats(listener: (stats: SurfaceStats[], tier: MotionTier) => void): () => void {
    this.statsListeners.add(listener);
    return () => this.statsListeners.delete(listener);
  }

  private readonly onWorkerMessage = (message: OrchestratorMessage) => {
    switch (message.type) {
      case 'canvas:stats':
        this.statsListeners.forEach(l => l(message.stats, message.tier));
        break;
      case 'canvas:tier-changed':
        // The orchestrator already switched; do not send the tier back to it.
        this._tier = message.tier;
        this.syncPointerListening();
        this.tierListeners.forEach(l => l(message.tier, message.reason));
        break;
    }
  };

  private readonly onDprChange = () => {
    this.attachments.forEach(attachment => {
      this.deps.post({ type: 'canvas:resize', surfaceId: attachment.surfaceId, size: this.sizeOf(attachment) });
    });
  };

  // ---- pointer ---------------------------------------------------------------

  private syncPointerListening() {
    const want = this._tier === 'full';
    if (want === this.pointerListening) return;
    this.pointerListening = want;
    POINTER_EVENTS.forEach(type => {
      if (want) this.deps.pointerTarget.addEventListener(type, this.onPointer, { passive: true });
      else this.deps.pointerTarget.removeEventListener(type, this.onPointer);
    });
    if (!want) {
      this.lastPointer = null;
      this.lastSent.clear();
      if (this.flushId !== null) {
        this.deps.cancelFrame(this.flushId);
        this.flushId = null;
      }
    }
  }

  private readonly flushPointer = () => {
    this.flushId = null;
    const event = this.lastPointer;
    if (!event) return;
    const t = this.deps.now();

    this.attachments.forEach(attachment => {
      const { rect, surfaceId } = attachment;
      const sample: PointerSample = {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
        down: event.buttons !== 0,
        inside:
          event.clientX >= rect.left && event.clientX < rect.left + rect.width &&
          event.clientY >= rect.top && event.clientY < rect.top + rect.height,
        t,
      };
      const previous = this.lastSent.get(surfaceId);
      if (previous && previous.x === sample.x && previous.y === sample.y && previous.down === sample.down) return;
      this.lastSent.set(surfaceId, sample);
      this.deps.post({ type: 'canvas:pointer', surfaceId, pointer: sample });
    });
  };

  // ---- lifecycle -------------------------------------------------------------

  dispose(): void {
    [...this.attachments.values()].forEach(attachment => this.detachNow(attachment));
    this._tier = 'off';
    this.syncPointerListening();
    this.unsubscribeWorker();
    this.unwatchDpr();
    this.deps.visibilityTarget.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.statsListeners.clear();
    this.tierListeners.clear();
  }
}
