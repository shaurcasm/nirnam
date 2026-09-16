/**
 * The orchestrator for the canvas tab, in a module both the worker entry
 * and the inline (main-thread) arm call — the same code either side of
 * the thread boundary, which is what makes the comparison fair.
 */

import { createOrchestrator, layers } from '@palinc/nirnam/canvas';
import type { OrchestratorScope } from '@palinc/nirnam/canvas';
import { StripSurface } from './StripSurface';

export function setupOrchestrator(scope?: OrchestratorScope) {
  return createOrchestrator({
    surfaces: { background: layers({ strips: () => new StripSurface() }) },
    statsIntervalMs: 500,
    // The benchmark wants to see over-budget frames, not have them hidden by a step-down.
    stepDownAfter: 0,
    scope,
  });
}
