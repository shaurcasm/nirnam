/**
 * With Nirnam, a participant in a worker: `bus.adoptWorker(worker)` on the
 * page, `connectWorkerBus()` in the worker (echo.worker.ts), and from then
 * on the worker's publishes reach the hub without a main-thread task in
 * between. The main thread pays only for what it subscribes to.
 *
 * Everything main-thread — subscribe, publish, request — is the same bus
 * as the `dedicated` arm; the worker workloads are what this arm adds.
 */

import { createBus } from '@palinc/nirnam';
import type { NirnamBus } from '@palinc/nirnam';
import type { TransportArm } from '../arm';

/** The worker's handler is not there until it has joined; ask until it answers. */
async function untilReady(bus: NirnamBus): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      await bus.request('bench:worker:ready', null, 1000);
      return;
    } catch {
      await new Promise(r => setTimeout(r, 25));
    }
  }
  throw new Error('worker never joined the bus');
}

export function nirnamWorkerArm(): TransportArm {
  let bus: NirnamBus | null = null;
  let worker: Worker | null = null;
  let adoption: { release(): void } | null = null;
  const b = () => {
    if (!bus) throw new Error('arm not set up');
    return bus;
  };
  return {
    id: 'nirnam-worker',
    label: 'Nirnam · worker participant',
    note: 'dedicated hub + a worker on the bus · worker traffic never touches main',
    async setup() {
      bus = createBus();
      worker = new Worker(new URL('../echo.worker.ts', import.meta.url), { type: 'module' });
      adoption = bus.adoptWorker(worker);
      await untilReady(bus);
    },
    async teardown() {
      adoption?.release();
      worker?.terminate();
      bus?.close();
      adoption = worker = bus = null;
    },
    subscribe: (topic, handler) => b().subscribe(topic, handler),
    publish: (topic, payload) => b().publish(topic, payload),
    handle: (topic, handler) => b().handle(topic, handler),
    request: (topic, payload) => b().request(topic, payload),
    handleStream: (topic, handler) => b().handleStream(topic, handler),
    requestStream: (topic, payload) => b().requestStream(topic, payload),
    async workerPublish(topic, count) {
      await b().request('bench:worker:publish', { topic, count });
    },
    workerRequest: payload => b().request('bench:worker:echo', payload),
  };
}
