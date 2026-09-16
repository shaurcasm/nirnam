/**
 * inlineWorker — the orchestrator on the calling thread, behind a Worker's
 * shape.
 *
 * Everything the host does to a real worker — `postMessage` with transfers,
 * `addEventListener('message')`, `terminate()`, being handed to
 * `bus.adoptWorker` — works unchanged; underneath, a `MessageChannel` carries
 * the same protocol to an orchestrator created right here. Messages still
 * arrive as separate tasks and an `OffscreenCanvas` is still transferred,
 * only never across a thread.
 *
 * When to reach for it:
 *
 * - **Measuring.** The same surfaces, the same runtime, the other thread —
 *   what a benchmark of "with the worker / without" wants, with nothing else
 *   different.
 * - **Falling back.** A browser with OffscreenCanvas but a worker that cannot
 *   be started (a strict CSP, a build without a worker bundle) still animates.
 * - **Testing.** A host and an orchestrator together in one Node process.
 *
 *   const worker = inlineWorker(scope => createOrchestrator({ surfaces, scope }));
 *   <CanvasHost worker={() => worker} … />
 *
 * The setup callback receives the orchestrator's scope and may also hand it
 * to `connectWorkerBus({ scope })`, exactly as a worker file would, so the
 * inline arm joins the bus the same way.
 */

import type { OrchestratorScope } from './orchestrator';

/** The part of `Worker` the canvas host and the bus actually use. */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  terminate(): void;
}

/** What `inlineWorker` runs on the "worker" side. Return the orchestrator so `terminate()` can dispose it. */
export type InlineSetup = (scope: OrchestratorScope) => { dispose(): void } | void;

type MessageListener = (event: MessageEvent) => void;

interface ChannelPort {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(data: unknown, transfer?: Transferable[]): void;
  start?(): void;
  close(): void;
}

export function inlineWorker(setup: InlineSetup): WorkerLike {
  const { port1, port2 } = new MessageChannel() as unknown as { port1: ChannelPort; port2: ChannelPort };
  // port1 is the worker side — what the orchestrator sees as `self`;
  // port2 is the page side — what the host holds as the worker.
  const insideListeners = new Set<MessageListener>();
  const outsideListeners = new Set<MessageListener>();
  let alive = true;

  port1.onmessage = event => insideListeners.forEach(l => l(event));
  port2.onmessage = event => outsideListeners.forEach(l => l(event));
  port1.start?.();
  port2.start?.();

  const scope: OrchestratorScope = {
    addEventListener: (_type, listener) => void insideListeners.add(listener),
    removeEventListener: (_type, listener) => void insideListeners.delete(listener),
    postMessage: data => {
      if (alive) port1.postMessage(data);
    },
  };

  const inside = setup(scope) ?? null;

  return {
    postMessage(message, transfer = []) {
      if (alive) port2.postMessage(message, transfer);
    },
    addEventListener(_type, listener) {
      outsideListeners.add(listener);
    },
    removeEventListener(_type, listener) {
      outsideListeners.delete(listener);
    },
    terminate() {
      if (!alive) return;
      alive = false;
      inside?.dispose();
      insideListeners.clear();
      outsideListeners.clear();
      port1.onmessage = null;
      port2.onmessage = null;
      port1.close();
      port2.close();
    },
  };
}
