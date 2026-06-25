# Nirnam â€” Features Roadmap

This document tracks planned features on top of the core three-layer hybrid bus
(SharedWorker + BroadcastChannel + opt-in static URL).

The current library (`Library/`) ships:
- `publish` / `subscribe` â€” BROAD fan-out (Layer 1 + 2)
- `request` / `handle` â€” NARROW request-reply with correlation IDs (Layer 2)
- `createBus(options?)` â€” clean factory, no singleton anti-pattern

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
