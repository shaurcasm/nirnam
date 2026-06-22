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

**Status:** Planned.

**Purpose:** When a new agent or tab joins, it can replay recent messages on a topic â€” useful for catching up on tool call history in multi-agent LLM scenarios.

**Design (from TRANSPORT_LAYER_ANALYSIS.md Â§4.2):**
- Producer writes to IndexedDB on `publish`
- BroadcastChannel signals new message
- Consumer reads from IndexedDB on join to replay missed events
- Opt-in per topic: `bus.publish('my-topic', data, { persist: true, ttl: 60000 })`
- `bus.subscribe('my-topic', handler, { replay: 10 })` â€” replay last 10 messages on subscribe

---

## 7. Static Worker Deployment Tooling (Build Plugins)

**Status:** Planned.

**Purpose:** Make Layer 3 (static URL SharedWorker) easy to enable without manual file copy.

**Planned plugins:**
- `@palinc/nirnam/vite` â€” Vite plugin that copies `worker.js` to `public/` and injects the URL
- `@palinc/nirnam/rsbuild` â€” Rsbuild/Rspack plugin (same pattern)
- `@palinc/nirnam/webpack` â€” Webpack `CopyWebpackPlugin` config helper

**Usage:**
```ts
// vite.config.ts
import { nirnamPlugin } from '@palinc/nirnam/vite';
export default { plugins: [nirnamPlugin()] };

// App code â€” URL auto-injected by plugin
const bus = createBus(); // automatically uses /nirnam-worker.js when plugin is present
```

---

## Luxury List

Features deprioritised until all core agent primitives are stable. Revisit after the `@palinc/nirnam/agents` subpath ships and is validated in real use.

### L1. Streaming tool-call capability detection

**What:** Probe the connected LLM endpoint at agent startup to detect whether it supports streaming while tool calls are in progress (not all OpenAI-compat servers do). Switch `chatStream()` to true end-to-end streaming when supported.

**Why deferred:** The current implementation uses non-streaming calls for the tool loop and streams only the final text response — which is correct and works everywhere. True streaming tool calls add parsing complexity and provider-specific edge cases. Core function is not blocked.

### L2. Cross-tab passive agents (scope: 'tab' | 'page')

**What:** A `scope: 'page'` option on `createAgent()` that causes the agent to live in the Layer 3 static SharedWorker, making it accessible across all tabs on the same origin and surviving soft navigations.

**Current behaviour (documented):** Agents run in the browser's main thread and are NOT shared across tabs. Each tab creates its own instances. Agents do NOT survive a page refresh. This is correctly documented in the `agents.ts` entry point JSDoc and in `AGENT_API_DESIGN.md`.

**Why deferred:** Requires significant worker-side changes: the agent's LLM client, tool executor, and File System Access API calls cannot run inside the SharedWorker (no fetch, no DOM APIs). A proxy/message-relay architecture between the shared worker and a designated “host tab” is required. This is a V2 breaking change.

**Temporary workaround for developers:** Use `autoCleanup: true` (default) and re-create agents on page load. The bus's agent registry (`bus.discoverAgents()`) remains accurate because `beforeunload` triggers deregistration.
