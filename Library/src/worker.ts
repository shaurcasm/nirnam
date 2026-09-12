/**
 * @palinc/nirnam/worker
 *
 * A bus for code that runs in a dedicated worker of your own.
 *
 * A worker cannot reach the hub by itself — `SharedWorker` is not exposed to
 * workers and the dedicated hub belongs to the page that made it. What a
 * worker can do is hold one end of a `MessageChannel` whose other end the
 * page's bus has adopted. Over that port it is a full participant: publish,
 * subscribe, request, handle, stream, register. Its traffic goes straight to
 * the hub and never crosses the main thread.
 *
 *   // main thread
 *   const worker = new Worker(new URL('./render.worker', import.meta.url), { type: 'module' });
 *   bus.adoptWorker(worker);
 *
 *   // render.worker.ts
 *   import { connectWorkerBus } from '@palinc/nirnam/worker';
 *   const bus = await connectWorkerBus();
 *   bus.subscribe('theme:changed', repaint);
 *
 * What a worker bus does not have: a BroadcastChannel. `publish()` from a
 * worker reaches every bus on the hub, not other tabs — a worker's world is
 * its page. `dispatchDOMEvents` is a no-op for the same reason.
 */

import { NirnamBus } from './bus';
import { connectionOverPort } from './hub-port';
import { NIRNAM_CONNECT } from './types';
import type { NirnamBusOptions } from './types';

export { NIRNAM_CONNECT };
export { NirnamBus };

export type WorkerBusOptions = Pick<NirnamBusOptions, 'requestTimeout' | 'persistence'>;

/** A bus over a port the page has already adopted into its hub. */
export function createWorkerBus(port: MessagePort, options: WorkerBusOptions = {}): NirnamBus {
  return new NirnamBus(options, connectionOverPort(port));
}

interface MessageScope {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

export interface ConnectWorkerBusOptions extends WorkerBusOptions {
  /** Where the connect message arrives. Defaults to the worker's global scope. */
  scope?: MessageScope;
}

/**
 * Wait for the page to call `bus.adoptWorker(worker)`, then resolve with a
 * bus over the port it sent. Other messages on the scope are left alone.
 */
export function connectWorkerBus(options: ConnectWorkerBusOptions = {}): Promise<NirnamBus> {
  const { scope = self as unknown as MessageScope, ...busOptions } = options;
  return new Promise((resolve) => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string } | null;
      const port = event.ports?.[0];
      if (data?.type !== NIRNAM_CONNECT || !port) return;
      scope.removeEventListener('message', onMessage);
      resolve(createWorkerBus(port, busOptions));
    };
    scope.addEventListener('message', onMessage);
  });
}
