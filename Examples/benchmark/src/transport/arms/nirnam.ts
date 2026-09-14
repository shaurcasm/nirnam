/**
 * With Nirnam: one bus, the hub where `createBus` puts it.
 *
 * - `inline`: the hub in this thread — zero hops, what tests and SSR use.
 * - `dedicated`: the hub in a Worker (the default) — every message is a
 *   task on the way out and a task on the way back, structured-cloned twice.
 *   That is the price of a hub that workers, iframes and other tabs can
 *   reach, and this arm shows what it is.
 *
 * The bus is used exactly as an app would: defaults, BroadcastChannel on.
 */

import { createBus } from '@palinc/nirnam';
import type { NirnamBus } from '@palinc/nirnam';
import type { TransportArm } from '../arm';

export function nirnamArm(hub: 'inline' | 'dedicated'): TransportArm {
  let bus: NirnamBus | null = null;
  const b = () => {
    if (!bus) throw new Error('arm not set up');
    return bus;
  };
  return {
    id: `nirnam-${hub}`,
    label: `Nirnam · ${hub} hub`,
    note: hub === 'inline' ? 'hub in this thread · zero hops' : 'hub in a Worker · two hops, two clones · the default',
    async setup() {
      bus = createBus({ hub });
    },
    async teardown() {
      bus?.close();
      bus = null;
    },
    subscribe: (topic, handler) => b().subscribe(topic, handler),
    publish: (topic, payload) => b().publish(topic, payload),
    handle: (topic, handler) => b().handle(topic, handler),
    request: (topic, payload) => b().request(topic, payload),
    handleStream: (topic, handler) => b().handleStream(topic, handler),
    requestStream: (topic, payload) => b().requestStream(topic, payload),
  };
}
