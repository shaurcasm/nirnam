/**
 * The two canvas arms differ in one line: where the orchestrator runs.
 * `worker` is the runtime as shipped; `inline` is the same runtime on the
 * main thread through `inlineWorker` — the control arm.
 */

import { inlineWorker } from '@palinc/nirnam/canvas';
import type { WorkerLike } from '@palinc/nirnam/canvas';
import { setupOrchestrator } from './orchestrator';

export interface CanvasArm {
  id: 'worker' | 'inline';
  label: string;
  note: string;
  createWorker(): WorkerLike;
}

export const CANVAS_ARMS: CanvasArm[] = [
  {
    id: 'worker',
    label: 'Nirnam · dedicated worker',
    note: 'OffscreenCanvas on a worker · the runtime as shipped',
    createWorker: () => new Worker(new URL('./bench.worker.ts', import.meta.url), { type: 'module' }),
  },
  {
    id: 'inline',
    label: 'Same runtime · main thread',
    note: 'inlineWorker() · identical surfaces and orchestrator · the control arm',
    createWorker: () => inlineWorker(setupOrchestrator),
  },
];
