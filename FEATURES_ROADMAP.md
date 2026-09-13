# Nirnam â€” Features Roadmap

This document tracks planned features on top of the core bus: a routing hub
in a Web Worker (dedicated by default, SharedWorker on request, inline for
tests) plus BroadcastChannel cross-tab fan-out. See §8 for the hub model;
older sections still say "Layer 1/2/3" where they were written against the
SharedWorker-only design.

---

## 1. Request-Reply Layer

**Status:** Complete.

**Shipped in v2.1:**
- `bus.request<Req, Res>(topic, payload, timeout?)` â€” sends a NARROW request, returns Promise
- `bus.handle<Req, Res>(topic, handler)` â€” registers a responder; sync and async handlers both supported
- `bus.requestStream<Req, Res>(topic, payload)` â€” returns `AsyncIterable<Res>` for streaming responses
- `bus.handleStream<Req, Res>(topic, handler)` â€” registers an async-generator handler that yields chunks
- Worker uses **round-robin** selection when multiple handlers are registered for the same topic
- `NirnamRequestError` â€” structured error class with `code: NirnamErrorCode` (`NO_HANDLER`, `HANDLER_REJECTED`, `TIMEOUT`, `STREAM_ABORTED`)
- Worker tracks `pendingRequests: Map<requestId, originPort>` and routes responses and stream chunks back

**Deferred:**
- **Cross-tab request-reply**: NARROW requests route within-page only (SharedWorker Layer 2). Cross-tab requires either a static URL SharedWorker (Layer 3) or a BroadcastChannel two-pass relay. Planned separately.

---

## 2. Agent Registration Protocol

**Status:** Complete.

**Purpose:** Enables agents (LLM remotes, MFE components) to announce their presence and capabilities at connect time, so an orchestrator can discover what tools are available without prior knowledge.

**Planned design:**

```ts
// On agent startup
bus.register({
  agentId: 'summarizer-agent',
  capabilities: ['summarize', 'translate'],
  metadata: { model: 'claude-sonnet-4-6', version: '1.0.0' },
});

// Orchestrator discovers agents
const agents = await bus.discoverAgents();
// => [{ agentId: 'summarizer-agent', capabilities: [...], ... }]

// Watch for agents joining/leaving
bus.onAgentChange((event) => {
  if (event.type === 'join') { /* new agent */ }
  if (event.type === 'leave') { /* agent disconnected */ }
});
```

**Worker-side changes needed:**
- New `register` message type: worker stores `agentId â†’ { port, capabilities, metadata }`
- New `discover` message type: worker responds with current registry snapshot
- Port `close` event cleans up registry entry and broadcasts a `leave` event to listeners
- Agent registry is per-worker-process (within-page). Cross-tab registry requires Layer 3 (static URL SharedWorker).

**Heartbeat:**
Workers can go stale if a port closes without firing `close`. A periodic heartbeat (`bus.register()` pings every N seconds) lets the worker evict silent agents.

---

## 3. NirnamMCPTransport

**Status:** Complete.

**Purpose:** Implement the [Model Context Protocol](https://modelcontextprotocol.io/) `Transport` interface on top of the Nirnam bus, enabling LLM agents loaded as micro-frontend remotes to expose MCP tools and call each other's tools â€” all client-side, without a server.

**Background:**
MCP defines a JSON-RPC 2.0 protocol with built-in transports (stdio, HTTP/SSE, WebSocket). The TypeScript SDK exposes a `Transport` interface that can be implemented over any message-passing channel. The Nirnam bus (SharedWorker + BroadcastChannel) is a suitable channel for browser-native, same-origin MCP.

**Planned design:**

```ts
import { NirnamMCPTransport } from '@palinc/nirnam/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';

// Agent acting as MCP server (exposes tools)
const serverTransport = new NirnamMCPTransport({ agentId: 'file-agent', bus });
const server = new Server({ name: 'file-agent', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: 'read_file', description: '...', inputSchema: { ... } }],
}));
await server.connect(serverTransport);

// Agent acting as MCP client (calls tools on other agents)
const clientTransport = new NirnamMCPTransport({ agentId: 'orchestrator', bus });
const client = new Client({ name: 'orchestrator', version: '1.0.0' }, { capabilities: {} });
await client.connect(clientTransport);
const tools = await client.listTools();
const result = await client.callTool({ name: 'read_file', arguments: { path: '/src/App.tsx' } });
```

**Transport interface implementation:**

```ts
class NirnamMCPTransport implements Transport {
  onmessage?: (message: JSONRPCMessage) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;

  async start(): Promise<void> {
    // Subscribe to MCP topic for this agentId
    this._unsub = this.bus.handle<JSONRPCMessage, JSONRPCMessage>(
      `mcp:${this.agentId}`,
      (message) => {
        this.onmessage?.(message);
        // Responses come back via the Promise returned by handle â€” not applicable here.
        // MCP uses onmessage for both requests and responses; the SDK drives routing.
      }
    );
  }

  async send(message: JSONRPCMessage): Promise<void> {
    // Route to target agent's topic
    const target = (message as any).params?._target ?? this.targetAgentId;
    this.bus.publish(`mcp:${target}`, message);
  }

  async close(): Promise<void> {
    this._unsub?.();
    this.onclose?.();
  }
}
```

**Key constraints:**
- Same-origin only (SharedWorker boundary). Cross-origin MFEs (different domains) cannot share the worker â€” they need WebSockets or a server-side relay.
- The `request` / `handle` bus primitives map cleanly to MCP's request-response pattern. Each MCP call becomes a Nirnam `request`, routing to the agent registered on that topic.
- Streaming tool results (for LLM token streaming) require the streaming response feature (see Â§1).

**Planned entry point:** `@palinc/nirnam/mcp` â€” a separate subpath export so the MCP SDK is an optional peer dependency and doesn't bloat the core bundle.

---

## 4. DataEvent + DOM Integration

**Status:** Complete.

**Purpose:** Allow Nirnam messages to propagate through the browser's standard DOM event system, enabling framework-agnostic event handling via `window.addEventListener` alongside the bus.

**Planned design:**

```ts
import { DataEvent, RequestType } from '@palinc/nirnam';

// Dispatch a typed broadcast event on the window
const event = new DataEvent(RequestType.BROAD, 'counter', 42);
window.dispatchEvent(event);

// Listen via standard DOM API
window.addEventListener('broad_counter', (e: DataEvent<number>) => {
  console.log(e.detail); // 42
});
```

**Shipped:**
- `DataEvent<T>` extends `CustomEvent<T>` — constructor: `new DataEvent(requestType, topic, detail)`
- Event name: `` `${requestType}_${topic}` `` (e.g. `broad_counter`)
- `NirnamBusOptions.dispatchDOMEvents?: boolean` — opt-in flag (default: `false`)
- When enabled, `bus.publish()` calls `window.dispatchEvent(new DataEvent(...))` after the bus dispatch
- `DataEvent` is exported from the main entry point: `import { DataEvent } from '@palinc/nirnam'`

**Entry point:** `@palinc/nirnam` (main bundle).

---

## 5. React / Angular Hooks & Services

**Status:** Complete.

**Purpose:** First-class framework integration so developers don't wire up bus lifecycle manually.

**Shipped:**

**React** (`@palinc/nirnam/react`):
- `NirnamProvider` — context provider; accepts a pre-created `bus` prop
- `useNirnam<T>(topic, initialValue?)` — subscribes on mount, unsubscribes on unmount, returns latest value
- `useNirnamPublish()` — returns a stable generic publish function
- `useNirnamRequest<Req, Res>()` — returns a function that calls `bus.request()`
- Peer dependency: `react >= 17`

**Angular** (`@palinc/nirnam/angular`):
- `NirnamService` — injectable class with RxJS-based API
- `provideNirnam(options?)` — Angular standalone providers array (Angular 14+)
- `NirnamModule.forRoot(options?)` — NgModule-style integration
- Peer dependency: `rxjs >= 6`

**React:**
```ts
import { useNirnam } from '@palinc/nirnam/react';

// Subscribes on mount, unsubscribes on unmount
const counter = useNirnam<number>('counter');

// Publish
const publish = useNirnamPublish();
publish('counter', 42);

// Request-reply
const result = useNirnamRequest<Req, Res>('my-topic', payload);
```

**Angular:**
```ts
// app.module.ts
NirnamModule.forRoot({ useBroadcastChannel: true })

// component
@Component({ ... })
class MyComponent {
  constructor(private nirnam: NirnamService) {}
  ngOnInit() {
    this.nirnam.subscribe<number>('counter').subscribe(count => this.counter = count);
  }
}
```

---

## 6. IndexedDB Message Persistence (Late-Subscriber Replay)

**Status:** Complete.

**Purpose:** When a new agent or tab joins, it can replay recent messages on a topic — useful for catching up on tool call history in multi-agent LLM scenarios.

**Shipped:**
- `bus.publish('my-topic', data, { persist: true, ttl?: number })` — opt-in per-message persistence; `ttl` defaults to `persistence.defaultTtl` on the bus options (default: 60 000 ms)
- `bus.subscribe('my-topic', handler, { replay: 10 })` — replay last N non-expired messages immediately after subscribing, in chronological order
- `NirnamBusOptions.persistence.defaultTtl` — bus-level default TTL, overridable per publish
- Each persisted message carries a UUID `messageId` as IDB primary key — duplicate `put()` calls for the same ID are idempotent (cross-tab deduplication is safe by design)
- Expired records are pruned asynchronously after every write via a cursor scan on the `by_expires` index — no background timers, no garbage accumulation
- `seq` counter (monotonically increasing within a session) tie-breaks same-millisecond writes so `replay` order is always deterministic
- IDB schema: `nirnam-persistence-v1` / `messages` store, indexed by `topic` and `expiresAt`

**Cross-tab & cross-refresh:** IndexedDB is origin-scoped browser storage — the persistence layer already works across all open tabs and survives page refreshes without Feature 7. Feature 7 (static URL SharedWorker) would optionally centralise writes into the shared worker for contention-free multi-tab publishing, but the read path is identical either way.

---

## 7. Static Worker Deployment Tooling (Build Plugins)

**Status:** Complete.

**Purpose:** Make Layer 3 (static URL SharedWorker) easy to enable without manual file copy.

**Shipped:**
- `@palinc/nirnam/vite` — Vite plugin: copies worker to `<publicDir>/nirnam-worker.js`, injects `__NIRNAM_STATIC_WORKER_URL__` via `define`
- `@palinc/nirnam/rsbuild` — Rsbuild plugin: copies worker to `<root>/public/nirnam-worker.js` on build + dev-server start, injects URL via `source.define`
- `@palinc/nirnam/webpack` — Webpack 5 plugin: emits worker as output asset, injects URL via an internal `DefinePlugin`
- All three plugins accept an optional `workerPath` option to customise the filename / URL
- `createBus()` automatically reads `__NIRNAM_STATIC_WORKER_URL__` injected at bundle time — no `workerUrl` option needed
- Explicit `createBus({ workerUrl })` takes precedence over the injected global
- Example: `Examples/static-worker/` — Vite + React demo with live cross-tab counter

**Mechanism:**

`bus.ts` declares `__NIRNAM_STATIC_WORKER_URL__: string | undefined` as an ambient global. Build
plugins substitute the identifier with the literal URL string before the app bundle is shipped.
Without a plugin the identifier stays `undefined` at runtime and the bus falls back to a Blob URL
(Layer 2 behaviour — unchanged).

**Usage:**
```ts
// vite.config.ts
import { nirnamPlugin } from '@palinc/nirnam/vite';
export default { plugins: [nirnamPlugin()] };

// rsbuild.config.ts
import { nirnamRsbuildPlugin } from '@palinc/nirnam/rsbuild';
export default defineConfig({ plugins: [nirnamRsbuildPlugin()] });

// webpack.config.js
const { NirnamWebpackPlugin } = require('@palinc/nirnam/webpack');
module.exports = { plugins: [new NirnamWebpackPlugin()] };

// App code — URL auto-injected by plugin, no options needed
const bus = createBus(); // automatically uses /nirnam-worker.js when plugin is present
```

---

## 8. Pluggable Hub — dedicated Worker by default (v2.0.0)

**Status:** Complete (branch `feat/pluggable-hub`, 2026-09-13). This is the 2.0 breaking change.

**Purpose:** `createBus()` currently constructs a `SharedWorker` unconditionally
(`bus.ts:89`, no feature detection). Chrome on Android does not implement
`SharedWorker`, so every mobile-first consumer throws at startup. Cross-tab
routing — the SharedWorker's reason to exist — is a niche need; surviving a
reload is better served by §6 (IndexedDB persistence). So the hub becomes a
choice, and the default becomes the one every browser has.

**Design:**

`MessageBus` in `worker-source.ts` is already environment-agnostic — it holds
ports and routes between them; `onconnect` is the only SharedWorker-specific
line. Extract it into `src/hub.ts`, which is (a) stringified into the worker
source as now and (b) importable on the main thread.

```ts
createBus({ hub?: 'dedicated' | 'shared' | 'inline' })   // default: 'dedicated'
```

| Hub | Reach | Hops (main → main) | Lifetime |
|---|---|---|---|
| `dedicated` | this page | 2, in-process | the page; `close()` calls `terminate()` |
| `shared` | every tab of the origin (Layers 2/3 today) | 2, possibly cross-process | last tab of the origin |
| `inline` | this page | 0 | the page; nothing to start — the test hub |

- `shared` is opt-in and feature-detected: `typeof SharedWorker === 'undefined'`
  falls back to `dedicated` with a `console.warn`, never a throw.
- Every hub accepts participants as transferred `MessagePort`s via a
  `{ type: 'connect' }` message carrying the port, handled by the same code
  `onconnect` calls today. On `shared` and `dedicated` that message arrives on
  the worker; on `inline` it is a direct call. This is the mechanism §9 builds on.
- Layer 1 (`BroadcastChannel`) is unchanged and hub-independent, so cross-tab
  fire-and-forget pub/sub still works under `dedicated`. What `dedicated`
  gives up is cross-tab request-reply and `scope: 'page'` agents — those
  document `hub: 'shared'` as a requirement.
- Build plugins (§7) stay useful under every worker hub: a static URL is what
  a strict `worker-src` CSP needs, and what lets a SharedWorker be shared
  across tabs. Without a plugin both worker hubs load from a Blob URL, classic
  mode.
- `bus.close()` on `dedicated` terminates the worker — a real teardown, which
  React StrictMode consumers currently work around by never closing.

**Breaking:** default hub changes; consumers relying on cross-tab request-reply
or page-scope agents must pass `hub: 'shared'`. Examples `cross-tab-agent/` and
`static-worker/` get that line and a note. Everything else is source-compatible.

**Shipped:**
- `src/hub.ts` — `MessageHub`, the routing core, in TypeScript; imported by the
  inline hub and bundled into the worker.
- `src/worker-entry.ts` → `scripts/build-worker.mjs` → generated
  `src/worker-source.ts` (5 KB). `npm run build:worker`; `--check` guards
  staleness and runs as a test.
- `src/hub-port.ts` — `openHubPort()`, `resolveHubKind()` with once-only
  warnings, per-URL dedicated-worker refcount, `disposeHubs()` for tests/HMR.
- `NirnamBus.hub`, `NirnamBus.adoptPort(port)`, `close()` that really leaves.
- Two latent bugs surfaced by routing tests through the real hub instead of a
  mock: the worker had no `error` case, so a handler rejection never reached
  the requester (it timed out); and a bus subscribed for broadcasts only
  dropped requests routed to it instead of answering `NO_HANDLER`.

**Tests:** `tests/hub.test.ts` (hub with fake ports), `tests/hub-port.test.ts`
(selection, fallback, worker lifetime, adoption), `tests/worker-source.test.ts`
(the generated bundle evaluated in a fake worker scope, both wiring paths),
and `tests/bus.test.ts` running the whole bus suite once per hub. The test
mocks are transport shims only — routing is the real `MessageHub`.

---

## 9. Worker Participants — `@palinc/nirnam/worker`

**Status:** Complete (branch `feat/pluggable-hub`, 2026-09-13; ships with v2.0.0).

**Purpose:** Let a dedicated worker be a full bus participant. `SharedWorker` is
`[Exposed=Window]`, so a worker can never call `createBus()`; and relaying
through the main thread puts every message on the thread the worker exists to
avoid. With §8's port adoption the worker holds one end of a `MessageChannel`
and the hub the other — worker ↔ hub traffic never touches main.

```ts
// main
const { port1, port2 } = new MessageChannel();
bus.adoptPort(port1);
worker.postMessage({ type: 'nirnam:connect' }, [port2]);

// worker
import { createWorkerBus } from '@palinc/nirnam/worker';
const bus = createWorkerBus(port2);   // subscribe / publish / request / handle / requestStream
```

**Shipped:** `NirnamBus` takes an optional pre-opened connection, which is all
`createWorkerBus(port)` needs (`bus.hub === 'port'`). `bus.adoptWorker(worker)`
does the handshake from the page — a fresh `MessageChannel`, one end adopted,
the other posted as `{ type: NIRNAM_CONNECT }` — and `connectWorkerBus()`
awaits it in the worker without taking over `self.onmessage`. No
`BroadcastChannel` in the worker client; the hub already fans out. No DOM
events.

**Tests:** `tests/worker-bus.test.ts` — a main-side bus on the `inline` hub and
a worker bus over a mock channel: publish, request, stream and agent discovery
in both directions, teardown, and both handshake helpers.

---

## 10. `@palinc/nirnam/canvas` — off-main-thread animation runtime

**Status:** `/canvas` and `/canvas/react` complete (branch `feat/pluggable-hub`, 2026-09-13; ships with v2.0.0). `/canvas/three` not started. Consumer: Wevaad Phase 8; design notes live there.

**Purpose:** The runtime for rendering animated surfaces on a dedicated worker
via `OffscreenCanvas`, with the worker on the bus (§9) for state at event
frequency and a direct port for the data plane (canvas transfer, pointer
input, audio levels). Nirnam ships the runtime; consumers ship the surfaces.
Mirrors the `agents` sub-package: own Rollup entries, optional peers, meant to
be imported lazily.

**Entries:**

`@palinc/nirnam/canvas` — worker side.
```ts
interface Surface<State = unknown> {
  attach(canvas: OffscreenCanvas, opts: { width: number; height: number; dpr: number }): void;
  resize(width: number, height: number, dpr: number): void;
  frame(dt: number, input: FrameInput): void;     // pointer, visibility, tier
  onState?(state: State): void;
  detach(): void;
}
createOrchestrator({ surfaces, budget: { targetFps, maxDpr } });
```
One `requestAnimationFrame` drives every attached surface (no phase drift
between them). Dispatch by `surfaceId`. Invisible surfaces skipped; hidden tab
stops the loop (worker `rAF` already throttles with the document). The
orchestrator measures its own frame time, publishes a 1 Hz stats summary on a
topic the host names, and steps its own tier down when p95 is over budget.

`@palinc/nirnam/canvas/react` — main side.
```tsx
<CanvasHost worker={() => new Worker(url, { type: 'module' })} tier="full" statsTopic="...">
const ref = useSurface('tree', { state });   // → <canvas ref={ref} />
```
Creates the worker once, performs the §9 handshake, and per surface: transfers
the canvas (guarding React StrictMode's double mount — `transferControlToOffscreen()`
is one-shot), forwards `ResizeObserver` size + DPR, `IntersectionObserver`
visibility, and pointer input batched via `getCoalescedEvents()` to one message
per frame over the direct port. Tier is a prop; the consumer decides it.

`@palinc/nirnam/canvas/three` — worker side, later (v2.2.0 or when pulled).
An R3F root on an `OffscreenCanvas`: `size` fed from host resize messages, an
`events` connector over the forwarded pointer stream, `ImageBitmapLoader` for
textures. Peers `three`, `@react-three/fiber`, optional.

**Non-goals:** any surface implementation; text or accessibility inside a
canvas (surfaces are decorative by contract); `SharedArrayBuffer` input
(needs cross-origin isolation, hostile to Module Federation).

**Shipped:** `src/canvas/types.ts` (the `Surface` contract and the host ↔
orchestrator protocol), `src/canvas/orchestrator.ts`, `src/canvas/host.ts`
(`CanvasHostController`, framework-free, every DOM dependency injectable),
`src/canvas/tier.ts` (`resolveMotionTier`, `probeMotionCapabilities`),
`src/canvas-react.ts` (`CanvasHost`, `useSurface`, `useMotionTier`).

Found while running `Examples/canvas/` in Chrome: terminating a worker does
not fire `close` on the ports it held, so the hub kept round-robining
requests onto dead participants (1 in 3 requests timed out after a
StrictMode start plus an off/on cycle). `adoptPort` / `adoptWorker` now
return an `Adoption` whose `release()` removes the port by id
(`disconnect-port`), and `CanvasHost` releases before it terminates.

Found by running the example with the tab in the background: worker
`requestAnimationFrame` is **not** throttled for hidden pages, so the loop
drew two full-viewport canvases at 60 fps for as long as the tab sat behind
another — a laptop's fans, in practice. The host now forwards
`visibilitychange` (`canvas:page-hidden`) and the orchestrator stops on it.
Alongside, `layers()` puts several surfaces on one canvas (the compositor
pays per canvas, not per pixel drawn) and `maxDpr` caps a surface below the
tier's cap, so a full-viewport background can run at 1x. The example went
from two canvases at device DPR to one at 1x — roughly a third of the
compositing work — and to zero while hidden. (v2.1.0)

**Tests:** `tests/canvas-orchestrator.test.ts` (fake clock: attach/detach,
one rAF for N surfaces, dt cap, frame-rate hold per tier, pointer withheld
under ambient, DPR cap, stats, step-down and its reset),
`tests/canvas-host.test.ts` (transfer once, deferred detach cancelled by a
remount, resize/DPR/visibility forwarding, pointer batching in canvas-local
pixels, tier relay), `tests/canvas-tier.test.ts`, and
`tests/canvas-defaults.test.ts` for the browser defaults behind the
injectable dependencies. The React binding is exercised by the example, not
unit-tested (Jest runs in Node here).

---

## Luxury List

Features deprioritised until all core agent primitives are stable. Revisit after the `@palinc/nirnam/agents` subpath ships and is validated in real use.

### L1. Streaming tool-call capability detection

**What:** Probe the connected LLM endpoint at agent startup to detect whether it supports streaming while tool calls are in progress (not all OpenAI-compat servers do). Switch `chatStream()` to true end-to-end streaming when supported.

**Why deferred:** The current implementation uses non-streaming calls for the tool loop and streams only the final text response — which is correct and works everywhere. True streaming tool calls add parsing complexity and provider-specific edge cases. Core function is not blocked.

### L2. Cross-tab passive agents (scope: 'tab' | 'page')

**Status:** Complete.

**Shipped:**
- `AgentConfig.scope?: 'tab' | 'page'` — opt-in per-agent. Default: `'tab'` (existing behaviour unchanged).
- `scope: 'page'` registers bus request handlers (`${agentId}:__chat`, `${agentId}:__run`, `${agentId}:__stream`) so any tab can call the agent.
- `AgentProxy` class — lightweight cross-tab proxy; forwards `chat()`, `run()`, `chatStream()` over the bus.
- `createAgentProxy(agentId, bus, options?)` — factory that returns an `AgentProxy` immediately (synchronous, no discovery round-trip).
- IndexedDB history persistence — page-scoped agents automatically save conversation history after each `chat()` / `chatStream()` call and restore it on the next page load (when the same `agentId` is used).
- Request serialisation queue — concurrent bus requests are queued internally so parallel calls from multiple proxy tabs never corrupt agent history.
- Both `AgentProxy` and the history store are re-exported from `@palinc/nirnam/agents`.

**Architecture:**
The agent's LLM client, tool executor, and File System Access API still run in the host tab's main thread. The Layer 3 SharedWorker acts purely as a message router — no agent logic runs inside the worker. This avoids all worker-API restrictions while keeping true cross-tab routing.

**Usage:**
```ts
// host tab (owns the real agent)
import { createAgent } from '@palinc/nirnam/agents';
const agent = createAgent({
  agentId: 'my-agent',       // stable ID required for history persistence
  scope: 'page',
  llm: { url: '...', model: 'gpt-4o', apiKey: '...' },
  bus,                        // Layer 3 bus (nirnamPlugin() active)
});
await agent.ready;

// any other tab
import { createAgentProxy } from '@palinc/nirnam/agents';
const proxy = createAgentProxy('my-agent', bus);
const reply = await proxy.chat('Hello!');
const stream = proxy.chatStream('Tell me a story');
```
