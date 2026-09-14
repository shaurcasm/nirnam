/**
 * With Nirnam, participants in workers: `bus.adoptWorker(worker)` on the
 * page, `connectWorkerBus()` in the worker (echo.worker.ts), and from then
 * on a worker's publishes reach the hub without a main-thread task in
 * between. The main thread pays only for what it subscribes to — and when
 * two workers talk to each other, it pays nothing at all.
 *
 * Everything main-thread — subscribe, publish, request — is the same bus
 * as the `dedicated` arm; the worker workloads are what this arm adds. Two
 * workers, `a` and `b`, named so their topics are their own.
 */

import { createBus } from '@palinc/nirnam';
import type { NirnamBus } from '@palinc/nirnam';
import type { TransportArm } from '../arm';
import { nextTask } from '../../harness/runner';

/** A worker's handlers are not there until it has joined; ask until it answers. */
async function untilReady(bus: NirnamBus, name: string): Promise<void> {
  const deadline = performance.now() + 10000;
  while (performance.now() < deadline) {
    try {
      await bus.request(`bench:${name}:ready`, null, 1000);
      return;
    } catch {
      await nextTask();
    }
  }
  throw new Error(`worker ${name} never joined the bus`);
}

const WORKERS = ['a', 'b'] as const;

// Vite wants each `new Worker` literal, options included — so two of them.
const spawn: Record<(typeof WORKERS)[number], () => Worker> = {
  a: () => new Worker(new URL('../echo.worker.ts', import.meta.url), { type: 'module', name: 'a' }),
  b: () => new Worker(new URL('../echo.worker.ts', import.meta.url), { type: 'module', name: 'b' }),
};

export function nirnamWorkerArm(): TransportArm {
  let bus: NirnamBus | null = null;
  let workers: Worker[] = [];
  let adoptions: Array<{ release(): void }> = [];
  const b = () => {
    if (!bus) throw new Error('arm not set up');
    return bus;
  };
  return {
    id: 'nirnam-worker',
    label: 'Nirnam · worker participants',
    note: 'dedicated hub + two workers on the bus · worker traffic never touches main',
    async setup() {
      const created = createBus();
      bus = created;
      workers = WORKERS.map(name => spawn[name]());
      adoptions = workers.map(w => created.adoptWorker(w));
      await Promise.all(WORKERS.map(name => untilReady(created, name)));
    },
    async teardown() {
      adoptions.forEach(a => a.release());
      workers.forEach(w => w.terminate());
      bus?.close();
      adoptions = [];
      workers = [];
      bus = null;
    },
    subscribe: (topic, handler) => b().subscribe(topic, handler),
    publish: (topic, payload) => b().publish(topic, payload),
    handle: (topic, handler) => b().handle(topic, handler),
    request: (topic, payload) => b().request(topic, payload),
    handleStream: (topic, handler) => b().handleStream(topic, handler),
    requestStream: (topic, payload) => b().requestStream(topic, payload),
    async workerPublish(topic, count) {
      await b().request('bench:a:publish', { topic, count });
    },
    workerRequest: payload => b().request('bench:a:echo', payload),
    async workerToWorker(topic, count) {
      const current = b();
      const done = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('worker b never reported')), 30000);
        const off = current.subscribe('bench:b:done', () => {
          clearTimeout(timer);
          off();
          resolve();
        });
      });
      await current.request('bench:b:expect', { topic, count });
      await current.request('bench:a:publish', { topic, count });
      await done;
    },
  };
}
