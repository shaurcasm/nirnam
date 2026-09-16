/**
 * The canvas worker: the orchestrator from ./orchestrator on this worker's
 * own scope. The main-thread arm calls the same function through
 * `inlineWorker`.
 */

import { setupOrchestrator } from './orchestrator';

setupOrchestrator();
