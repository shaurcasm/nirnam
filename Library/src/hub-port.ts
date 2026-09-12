/**
 * Opening a connection from a bus to a hub.
 *
 * The bus never sees a worker. It gets a `BusPort` — one end of something
 * that reaches a `MessageHub` — and a `release()` to give it back. Which
 * transport sits behind the port is decided here, once, from the requested
 * `HubKind` and what the environment actually provides.
 */

import { MessageHub } from './hub';
import type { HubPort } from './hub';
import type { HubKind, BusConnectionKind } from './types';

/** The client end of a hub connection: what `NirnamBus` talks to. */
export interface BusPort {
  postMessage(data: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent) => void) | null;
}

export interface HubConnection {
  readonly kind: BusConnectionKind;
  readonly port: BusPort;
  /** Leave the hub and release the transport behind the port. */
  release(): void;
}

const WORKER_NAME = 'nirnam-message-worker';

const warned = new Set<string>();

function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`[Nirnam] ${message}`);
}

/** The hub that will actually be used, given what this environment provides. */
export function resolveHubKind(requested: HubKind = 'dedicated'): HubKind {
  let kind = requested;
  if (kind === 'shared' && typeof SharedWorker === 'undefined') {
    warnOnce('SharedWorker is not available here; using a dedicated worker instead. Cross-tab request-reply is off.');
    kind = 'dedicated';
  }
  if (kind === 'dedicated' && (typeof Worker === 'undefined' || typeof MessageChannel === 'undefined')) {
    warnOnce('Web Workers are not available here; running the hub inline on this thread.');
    kind = 'inline';
  }
  return kind;
}

/**
 * @param resolveUrl Called only when a worker is actually created, so the
 *   inline hub never builds a Blob URL it will not use.
 */
export function openHubPort(requested: HubKind | undefined, resolveUrl: () => string): HubConnection {
  const kind = resolveHubKind(requested);
  switch (kind) {
    case 'inline':
      return openInline();
    case 'dedicated':
      return openDedicated(resolveUrl());
    case 'shared':
      return openShared(resolveUrl());
  }
}

/**
 * Drop every hub this module holds: terminate dedicated workers and forget the
 * inline hub. Buses still open are cut off. For test isolation and hot reload.
 */
export function disposeHubs(): void {
  dedicatedWorkers.forEach(({ worker }) => worker.terminate());
  dedicatedWorkers.clear();
  inlineHub = null;
}

// ---- inline ------------------------------------------------------------------

/** The two fields of a MessageEvent the hub and the bus read. */
function asEvent(data: unknown, ports: Transferable[] = []): MessageEvent {
  return { data, ports } as unknown as MessageEvent;
}

// One hub per page, like one worker per page: two buses created by the same
// module reach each other, which is what every other hub kind gives them.
let inlineHub: MessageHub | null = null;

function openInline(): HubConnection {
  const hub = inlineHub ?? (inlineHub = new MessageHub());

  // Two halves of a synchronous channel. Delivery happens inside the caller's
  // stack — there is no thread to hop to, so there is nothing to wait for.
  const hubSide: HubPort = {
    onmessage: null,
    postMessage: (data) => busSide.onmessage?.(asEvent(data)),
  };
  const busSide: BusPort = {
    onmessage: null,
    postMessage: (data, transfer) => hubSide.onmessage?.(asEvent(data, transfer)),
  };
  hub.connect(hubSide);

  return { kind: 'inline', port: busSide, release: () => hub.disconnect(hubSide) };
}

// ---- dedicated ---------------------------------------------------------------

// One worker per page per script URL, shared by every bus this module creates.
// Each bus gets its own MessageChannel into it; the worker terminates when the
// last bus releases.
const dedicatedWorkers = new Map<string, { worker: Worker; refs: number }>();

function openDedicated(url: string): HubConnection {
  let entry = dedicatedWorkers.get(url);
  if (!entry) {
    const worker = new Worker(url, { name: WORKER_NAME });
    worker.onerror = (e) => console.error('[Nirnam]', e);
    entry = { worker, refs: 0 };
    dedicatedWorkers.set(url, entry);
  }
  const shared = entry;
  shared.refs += 1;

  const { port1, port2 } = new MessageChannel();
  shared.worker.postMessage({ type: 'connect' }, [port2]);
  port1.start();

  return {
    kind: 'dedicated',
    port: port1,
    release: () => {
      port1.postMessage({ type: 'disconnect' });
      port1.close();
      shared.refs -= 1;
      if (shared.refs === 0) {
        shared.worker.terminate();
        dedicatedWorkers.delete(url);
      }
    },
  };
}

// ---- over a given port -------------------------------------------------------

/**
 * A connection over a port that some other bus has already adopted into its
 * hub — what `@palinc/nirnam/worker` builds on.
 */
export function connectionOverPort(port: MessagePort): HubConnection {
  port.start();
  return {
    kind: 'port',
    port,
    release: () => {
      port.postMessage({ type: 'disconnect' });
      port.close();
    },
  };
}

// ---- shared ------------------------------------------------------------------

function openShared(url: string): HubConnection {
  const worker = new SharedWorker(url, { name: WORKER_NAME });
  worker.onerror = (e) => console.error('[Nirnam]', e);
  worker.port.start();

  return {
    kind: 'shared',
    port: worker.port,
    release: () => {
      worker.port.postMessage({ type: 'disconnect' });
      worker.port.close();
    },
  };
}
