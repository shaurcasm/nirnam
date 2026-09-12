/**
 * @palinc/nirnam/canvas
 *
 * Off-main-thread animation: surfaces drawn into OffscreenCanvases by an
 * orchestrator in a dedicated worker, fed by a host on the main thread.
 *
 * Worker side:
 *   import { createOrchestrator } from '@palinc/nirnam/canvas';
 *   createOrchestrator({ surfaces: { tree: () => new TreeSurface() } });
 *
 * Main thread, without React:
 *   import { CanvasHostController } from '@palinc/nirnam/canvas';
 * With React:
 *   import { CanvasHost, useSurface } from '@palinc/nirnam/canvas/react';
 *
 * The runtime is here; surfaces are yours. Pair it with
 * `@palinc/nirnam/worker` for the orchestrator's worker to join the bus.
 */

export { createOrchestrator } from './canvas/orchestrator';
export type { Orchestrator, OrchestratorOptions, OrchestratorScope, OrchestratorClock } from './canvas/orchestrator';

export { CanvasHostController } from './canvas/host';
export type { HostDeps, HostOptions, SurfaceHandle } from './canvas/host';

export { resolveMotionTier, probeMotionCapabilities } from './canvas/tier';
export type { MotionCapabilities, MotionPreference, ProbeEnvironment } from './canvas/tier';

export { DEFAULT_BUDGETS } from './canvas/types';
export type {
  MotionTier,
  SurfaceSize,
  PointerSample,
  FrameInput,
  Surface,
  SurfaceFactory,
  TierBudget,
  SurfaceStats,
  HostMessage,
  OrchestratorMessage,
} from './canvas/types';
