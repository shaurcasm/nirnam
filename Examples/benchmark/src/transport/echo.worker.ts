/**
 * The worker side of the Nirnam worker arm. Joins the bus over the port
 * `adoptWorker` sent, then answers on topics named after itself
 * (`new Worker(url, { name })` → `self.name`): ready, echo, "publish N
 * messages on this topic" (the worker → main workload), and "expect N
 * messages on this topic and say when they have all arrived" (the worker →
 * worker workload — the main thread hears one message at the end, and
 * nothing in between).
 */

import { connectWorkerBus } from '@palinc/nirnam/worker';

const me = (self as unknown as { name?: string }).name || 'worker';

connectWorkerBus().then(bus => {
  bus.handle(`bench:${me}:ready`, () => true);
  bus.handle(`bench:${me}:echo`, payload => payload);
  bus.handle<{ topic: string; count: number }, number>(`bench:${me}:publish`, ({ topic, count }) => {
    for (let seq = 0; seq < count; seq++) {
      bus.publish(topic, { seq, sentAt: Date.now(), speaker: me, text: 'a transcript line from the worker' });
    }
    return count;
  });
  bus.handle<{ topic: string; count: number }, boolean>(`bench:${me}:expect`, ({ topic, count }) => {
    let received = 0;
    const off = bus.subscribe(topic, () => {
      received += 1;
      if (received >= count) {
        off();
        bus.publish(`bench:${me}:done`, { topic, count });
      }
    });
    return true;
  });
});
