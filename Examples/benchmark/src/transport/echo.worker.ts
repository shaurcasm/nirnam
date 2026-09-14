/**
 * The worker side of the Nirnam worker arm. Joins the bus over the port
 * `adoptWorker` sent, then answers three requests: ready, echo, and
 * "publish N messages on this topic" — the worker → main workload.
 */

import { connectWorkerBus } from '@palinc/nirnam/worker';

connectWorkerBus().then(bus => {
  bus.handle('bench:worker:ready', () => true);
  bus.handle('bench:worker:echo', payload => payload);
  bus.handle<{ topic: string; count: number }, number>('bench:worker:publish', ({ topic, count }) => {
    for (let seq = 0; seq < count; seq++) {
      bus.publish(topic, { seq, sentAt: Date.now(), speaker: 'worker', text: 'a transcript line from the worker' });
    }
    return count;
  });
});
