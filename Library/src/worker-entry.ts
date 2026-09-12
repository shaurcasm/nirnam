/**
 * The worker script — what runs inside the SharedWorker or dedicated Worker.
 *
 * Bundled to a single string by `scripts/build-worker.mjs` and embedded as
 * `src/worker-source.ts`, so the library is self-contained and needs no
 * static file deployment by default. Do not import this module from the
 * library; it assumes a worker global scope.
 *
 * The only difference between the two worker kinds is how ports arrive:
 * a SharedWorker gets one per connecting page through `onconnect`; a
 * dedicated Worker gets them transferred in `{ type: 'connect' }` messages
 * from the page that created it. Either way the hub does the rest.
 */

import { MessageHub } from './hub';
import type { HubPort } from './hub';

interface WorkerScope {
  onconnect?: ((event: MessageEvent) => void) | null;
  onmessage?: ((event: MessageEvent) => void) | null;
}

const hub = new MessageHub();
const scope = self as unknown as WorkerScope;

function firstPort(event: MessageEvent): HubPort | undefined {
  return event.ports?.[0];
}

if ('onconnect' in scope) {
  scope.onconnect = (event) => {
    const port = firstPort(event);
    if (port) hub.connect(port);
  };
} else {
  scope.onmessage = (event) => {
    const data = event.data as { type?: string } | null;
    const port = firstPort(event);
    if (data?.type === 'connect' && port) hub.connect(port);
  };
}
