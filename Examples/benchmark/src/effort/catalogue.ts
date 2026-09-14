/**
 * The development-effort comparison, read from the source that actually
 * ran: every arm's own file(s), counted; and next to them the library
 * source each Nirnam arm leans on — the lines the app did not write, and
 * the estimate of what "without" would cost to own once the plain arm
 * needs the same reach.
 *
 * Feature rows are what each arm can do *as written here*, not what it
 * could be extended to do. "hand-rolled" means the arm had to write it to
 * take part in a workload.
 */

import { countLines, type LineCount } from './loc';

// Arms — the app-side code of each.
import emitterSrc from '../transport/arms/emitter.ts?raw';
import customEventSrc from '../transport/arms/customEvent.ts?raw';
import rawPostMessageSrc from '../transport/arms/rawPostMessage.ts?raw';
import rawEchoWorkerSrc from '../transport/raw-echo.worker.ts?raw';
import nirnamSrc from '../transport/arms/nirnam.ts?raw';
import nirnamWorkerSrc from '../transport/arms/nirnamWorker.ts?raw';
import echoWorkerSrc from '../transport/echo.worker.ts?raw';

import mcpInMemorySrc from '../mcp/arms/inMemory.ts?raw';
import mcpRawSrc from '../mcp/arms/rawPostMessage.ts?raw';
import mcpRawWorkerSrc from '../mcp/raw-mcp.worker.ts?raw';
import mcpNirnamMainSrc from '../mcp/arms/nirnamMain.ts?raw';
import mcpNirnamWorkerSrc from '../mcp/arms/nirnamWorker.ts?raw';
import mcpWorkerSrc from '../mcp/mcp.worker.ts?raw';

import canvasArmsSrc from '../canvas/arms.ts?raw';
import canvasOrchestratorSrc from '../canvas/orchestrator.ts?raw';
import canvasWorkerSrc from '../canvas/bench.worker.ts?raw';

// The library — what a Nirnam arm gets for an import.
import libBusSrc from '../../../../Library/src/bus.ts?raw';
import libHubSrc from '../../../../Library/src/hub.ts?raw';
import libHubPortSrc from '../../../../Library/src/hub-port.ts?raw';
import libWorkerSrc from '../../../../Library/src/worker.ts?raw';
import libWorkerEntrySrc from '../../../../Library/src/worker-entry.ts?raw';
import libMcpSrc from '../../../../Library/src/mcp.ts?raw';
import libCanvasHostSrc from '../../../../Library/src/canvas/host.ts?raw';
import libCanvasOrchestratorSrc from '../../../../Library/src/canvas/orchestrator.ts?raw';
import libCanvasLayersSrc from '../../../../Library/src/canvas/layers.ts?raw';
import libCanvasTierSrc from '../../../../Library/src/canvas/tier.ts?raw';
import libCanvasInlineSrc from '../../../../Library/src/canvas/inline.ts?raw';
import libCanvasReactSrc from '../../../../Library/src/canvas-react.ts?raw';

export interface CountedFile {
  path: string;
  lines: LineCount;
}

export interface EffortArm {
  id: string;
  label: string;
  nirnam: boolean;
  files: CountedFile[];
  /** Feature id → true (has it), false (cannot), or 'hand-rolled' (wrote it here). */
  features: Record<string, boolean | 'hand-rolled'>;
}

export interface EffortSection {
  id: 'transport' | 'mcp' | 'canvas';
  title: string;
  featureLabels: Record<string, string>;
  arms: EffortArm[];
  /** The library source the Nirnam arms lean on. */
  library: CountedFile[];
  /** A paragraph the numbers need. */
  reading: string;
}

const file = (path: string, src: string): CountedFile => ({ path, lines: countLines(src) });

export const total = (files: CountedFile[]) => files.reduce((s, f) => s + f.lines.code, 0);

export const EFFORT: EffortSection[] = [
  {
    id: 'transport',
    title: 'Micro-frontend transport',
    featureLabels: {
      pubsub: 'pub/sub',
      requestReply: 'request-reply with timeout',
      stream: 'streaming',
      worker: 'a worker as a participant',
      tabs: 'other tabs',
      iframes: 'iframes and remotes without a shared import',
      replay: 'late-subscriber replay',
      discovery: 'agent discovery',
    },
    arms: [
      {
        id: 'emitter',
        label: 'In-memory emitter',
        nirnam: false,
        files: [file('transport/arms/emitter.ts', emitterSrc)],
        features: { pubsub: true, requestReply: 'hand-rolled', stream: 'hand-rolled', worker: false, tabs: false, iframes: false, replay: false, discovery: false },
      },
      {
        id: 'custom-event',
        label: 'window CustomEvent',
        nirnam: false,
        files: [file('transport/arms/customEvent.ts', customEventSrc)],
        features: { pubsub: true, requestReply: 'hand-rolled', stream: false, worker: false, tabs: false, iframes: false, replay: false, discovery: false },
      },
      {
        id: 'raw-postmessage',
        label: 'Raw postMessage worker',
        nirnam: false,
        files: [file('transport/arms/rawPostMessage.ts', rawPostMessageSrc), file('transport/raw-echo.worker.ts', rawEchoWorkerSrc)],
        features: { pubsub: 'hand-rolled', requestReply: 'hand-rolled', stream: false, worker: 'hand-rolled', tabs: false, iframes: false, replay: false, discovery: false },
      },
      {
        id: 'nirnam',
        label: 'Nirnam (inline / dedicated hub)',
        nirnam: true,
        files: [file('transport/arms/nirnam.ts', nirnamSrc)],
        features: { pubsub: true, requestReply: true, stream: true, worker: true, tabs: true, iframes: true, replay: true, discovery: true },
      },
      {
        id: 'nirnam-worker',
        label: 'Nirnam worker participant',
        nirnam: true,
        files: [file('transport/arms/nirnamWorker.ts', nirnamWorkerSrc), file('transport/echo.worker.ts', echoWorkerSrc)],
        features: { pubsub: true, requestReply: true, stream: true, worker: true, tabs: true, iframes: true, replay: true, discovery: true },
      },
    ],
    library: [
      file('Library/src/bus.ts', libBusSrc),
      file('Library/src/hub.ts', libHubSrc),
      file('Library/src/hub-port.ts', libHubPortSrc),
      file('Library/src/worker.ts', libWorkerSrc),
      file('Library/src/worker-entry.ts', libWorkerEntrySrc),
    ],
    reading:
      'The emitter is the fewest lines and the fastest, and that is the whole story while every participant is on the main thread. ' +
      'The moment one is not — a worker, an iframe, a second tab — the plain arm is the raw postMessage one: a hub written by hand, ' +
      'with correlation ids and timeouts, for one worker. The Nirnam arms are the same handful of lines whichever of those it turns out to be.',
  },
  {
    id: 'mcp',
    title: 'MCP transport',
    featureLabels: {
      sameModule: 'server and client in one module',
      acrossMfes: 'server in another MFE',
      worker: 'server in a worker',
      tabs: 'server in another tab',
      manyServers: 'several servers, one client each',
      transportClasses: 'Transport classes to own',
    },
    arms: [
      {
        id: 'in-memory',
        label: 'SDK InMemoryTransport',
        nirnam: false,
        files: [file('mcp/arms/inMemory.ts', mcpInMemorySrc)],
        features: { sameModule: true, acrossMfes: false, worker: false, tabs: false, manyServers: 'hand-rolled', transportClasses: true },
      },
      {
        id: 'raw-postmessage',
        label: 'Raw postMessage transport',
        nirnam: false,
        files: [file('mcp/arms/rawPostMessage.ts', mcpRawSrc), file('mcp/raw-mcp.worker.ts', mcpRawWorkerSrc)],
        features: { sameModule: false, acrossMfes: false, worker: 'hand-rolled', tabs: false, manyServers: 'hand-rolled', transportClasses: 'hand-rolled' },
      },
      {
        id: 'nirnam-main',
        label: 'Nirnam, server on main',
        nirnam: true,
        files: [file('mcp/arms/nirnamMain.ts', mcpNirnamMainSrc)],
        features: { sameModule: true, acrossMfes: true, worker: true, tabs: true, manyServers: true, transportClasses: true },
      },
      {
        id: 'nirnam-worker',
        label: 'Nirnam, server in a worker',
        nirnam: true,
        files: [file('mcp/arms/nirnamWorker.ts', mcpNirnamWorkerSrc), file('mcp/mcp.worker.ts', mcpWorkerSrc)],
        features: { sameModule: true, acrossMfes: true, worker: true, tabs: true, manyServers: true, transportClasses: true },
      },
    ],
    library: [file('Library/src/mcp.ts', libMcpSrc)],
    reading:
      'The SDK’s InMemoryTransport is the right answer when server and client share a module — and only then. ' +
      'A server anywhere else means a Transport class on each side of every boundary; the raw arm is the smallest such pair. ' +
      'With Nirnam the transport is one class over the bus, and where the server runs is an addressing detail: the worker arm’s client is the main arm’s client.',
  },
  {
    id: 'canvas',
    title: 'Off-main-thread canvas',
    featureLabels: {
      transferOnce: 'transfer once, survive StrictMode',
      sizeDpr: 'size, DPR and DPR changes',
      visibility: 'skip off-screen surfaces',
      pageHidden: 'stop when the tab is hidden',
      pointer: 'pointer input, batched per frame',
      tier: 'motion tiers and self step-down',
      stats: 'frame timing and one-off costs',
      layers: 'several layers on one canvas',
      inline: 'the same runtime on the main thread',
    },
    arms: [
      {
        id: 'nirnam',
        label: 'Nirnam canvas runtime (both arms)',
        nirnam: true,
        files: [file('canvas/arms.ts', canvasArmsSrc), file('canvas/orchestrator.ts', canvasOrchestratorSrc), file('canvas/bench.worker.ts', canvasWorkerSrc)],
        features: { transferOnce: true, sizeDpr: true, visibility: true, pageHidden: true, pointer: true, tier: true, stats: true, layers: true, inline: true },
      },
    ],
    library: [
      file('Library/src/canvas/host.ts', libCanvasHostSrc),
      file('Library/src/canvas/orchestrator.ts', libCanvasOrchestratorSrc),
      file('Library/src/canvas/layers.ts', libCanvasLayersSrc),
      file('Library/src/canvas/tier.ts', libCanvasTierSrc),
      file('Library/src/canvas/inline.ts', libCanvasInlineSrc),
      file('Library/src/canvas-react.ts', libCanvasReactSrc),
    ],
    reading:
      'There is no plain arm here on purpose: the fair performance control is the same runtime on the main thread, which is what the inline arm is. ' +
      'The effort comparison is the library column — the host, the loop, the tiers and the stats are what an app would own to draw on a worker without it; ' +
      'the surface (StripSurface.ts) is the app’s in both cases and is not counted.',
  },
];
