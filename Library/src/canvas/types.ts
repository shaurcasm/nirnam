/**
 * @palinc/nirnam/canvas — shared types and the wire protocol between a host
 * (main thread) and an orchestrator (dedicated worker).
 *
 * The protocol is the data plane: it carries the canvas itself, sizes,
 * visibility and pointer samples over the worker's own message port. State
 * that means something to the rest of the app — theme, route, tier — is
 * better published on the bus, which the orchestrator's worker can join with
 * `@palinc/nirnam/worker`.
 */

/**
 * How much motion a device gets.
 *
 * - `full` — everything, pointer reaction included.
 * - `ambient` — drift only: lower frame rate, lower DPR, no pointer.
 * - `off` — nothing runs; the host does not even start the worker.
 */
export type MotionTier = 'full' | 'ambient' | 'off';

/** A surface's size in CSS pixels plus the device pixel ratio to draw at. */
export interface SurfaceSize {
  width: number;
  height: number;
  dpr: number;
}

/** The latest pointer sample, in the surface's own CSS-pixel coordinates. */
export interface PointerSample {
  x: number;
  y: number;
  /** A button or finger is down. */
  down: boolean;
  /** The pointer is over the surface's box. Outside, x/y are still valid. */
  inside: boolean;
  /** `performance.now()` on the main thread when sampled. */
  t: number;
}

/** What a surface is told every frame. */
export interface FrameInput {
  /** `null` until a sample arrives, and always under the `ambient` tier. */
  pointer: PointerSample | null;
  tier: MotionTier;
  size: SurfaceSize;
  /** Milliseconds since the loop started. */
  elapsed: number;
  /**
   * Tell the stats about a one-off cost — a cache repainted, a texture
   * rebuilt — by name, with how long it took. Frame timing alone hides these:
   * the frame that repaints is one long frame among sixty, and what it
   * costs after — raster on the GPU the whole page waits for — is not on
   * this thread at all. Reported costs come back in `SurfaceStats.events`.
   * Absent when nothing is collecting.
   */
  report?: (name: string, ms: number) => void;
}

/**
 * One animated thing. Lives in the worker, draws into the OffscreenCanvas it
 * is attached to, and never touches the DOM. Implementations are plain
 * objects; the orchestrator owns the frame loop.
 */
export interface Surface<State = unknown> {
  attach(canvas: OffscreenCanvas, size: SurfaceSize): void;
  resize?(size: SurfaceSize): void;
  /** @param dt Milliseconds since the previous frame, capped so a hidden tab cannot produce a huge step. */
  frame(dt: number, input: FrameInput): void;
  /** Control-plane updates from the host or from bus topics. */
  onState?(state: State): void;
  detach?(): void;
}

export type SurfaceFactory = () => Surface;

/** Per-tier frame budget. */
export interface TierBudget {
  targetFps: number;
  maxDpr: number;
}

export const DEFAULT_BUDGETS: Readonly<Record<Exclude<MotionTier, 'off'>, TierBudget>> = {
  full: { targetFps: 60, maxDpr: 2 },
  ambient: { targetFps: 30, maxDpr: 1.5 },
};

/** A one-off cost a surface reported through `FrameInput.report`, totalled over the interval. */
export interface SurfaceEvent {
  name: string;
  count: number;
  /** Total milliseconds across the interval's occurrences. */
  ms: number;
}

/** Frame timing for one surface over the last stats interval. */
export interface SurfaceStats {
  surfaceId: string;
  frames: number;
  /** Frame durations in ms. */
  p50: number;
  p95: number;
  /** Frames whose duration exceeded the tier's budget. */
  over: number;
  /** Costs the surface reported, by name; empty when it reported none. */
  events: SurfaceEvent[];
}

// ---- Protocol: host → orchestrator ------------------------------------------

export interface AttachMessage {
  type: 'canvas:attach';
  surfaceId: string;
  canvas: OffscreenCanvas;
  size: SurfaceSize;
}
export interface ResizeMessage {
  type: 'canvas:resize';
  surfaceId: string;
  size: SurfaceSize;
}
export interface VisibleMessage {
  type: 'canvas:visible';
  surfaceId: string;
  visible: boolean;
}
export interface PointerMessage {
  type: 'canvas:pointer';
  surfaceId: string;
  pointer: PointerSample;
}
export interface StateMessage {
  type: 'canvas:state';
  surfaceId: string;
  state: unknown;
}
export interface DetachMessage {
  type: 'canvas:detach';
  surfaceId: string;
}
export interface TierMessage {
  type: 'canvas:tier';
  tier: MotionTier;
}
/**
 * The document went hidden or came back. Worker `requestAnimationFrame` is
 * not throttled for background tabs, so without this the loop would draw
 * full frames nobody sees for as long as the tab sits behind another.
 */
export interface PageHiddenMessage {
  type: 'canvas:page-hidden';
  hidden: boolean;
}

export type HostMessage =
  | AttachMessage
  | ResizeMessage
  | VisibleMessage
  | PointerMessage
  | StateMessage
  | DetachMessage
  | TierMessage
  | PageHiddenMessage;

// ---- Protocol: orchestrator → host ------------------------------------------

export interface StatsMessage {
  type: 'canvas:stats';
  tier: MotionTier;
  stats: SurfaceStats[];
}
/** The orchestrator stepped its own tier down after sustained overrun. */
export interface TierChangedMessage {
  type: 'canvas:tier-changed';
  tier: MotionTier;
  reason: 'over-budget';
}

export type OrchestratorMessage = StatsMessage | TierChangedMessage;
