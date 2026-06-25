# @palinc/nirnam — Transport Layer Context

> Authoritative reference for the core Nirnam bus, MCP transport, React integration,
> build plugins (Layer 3), cross-tab agent routing, and all exported types.
> Generated from source — keep in sync with `Library/src/`.

---

## Architecture overview

Nirnam runs a **three-layer hybrid message bus** in every browser context that imports it.

| Layer | Mechanism | Scope | Routing features |
|-------|-----------|-------|-----------------|
| 1 | `BroadcastChannel` | Cross-tab, same origin | Pub/sub fan-out only |
| 2 | Blob-URL `SharedWorker` | Within-page (all bundles on the same tab) | Pub/sub, request-reply, streaming, agent registry |
| 3 | Static-URL `SharedWorker` (opt-in) | True cross-tab + same page | All features, persists across tabs |

`createBus()` defaults to Layer 1 + 2. Pass `workerUrl` — or activate a build plugin — to engage Layer 3.

Each MFE (or component) calls `createBus()` independently. All instances on the same page share the **same SharedWorker process**, so messages route between them without any module-level state sharing.

---

## Installation & import

```ts
import { createBus, NirnamBus, NirnamRequestError, NirnamErrorCode } from '@palinc/nirnam';
import type {
  NirnamBusOptions, UnsubscribeFn, SubscribeHandler, RequestHandler,
  StreamHandler, AgentRegistration, AgentChangeEvent,
} from '@palinc/nirnam';
```

Subpaths:

| Subpath | Contents |
|---------|----------|
| `@palinc/nirnam` | Core bus (all environments) |
| `@palinc/nirnam/react` | `NirnamProvider`, `useNirnam`, `useNirnamPublish`, `useNirnamRequest` |
| `@palinc/nirnam/mcp` | `NirnamMCPTransport` |
| `@palinc/nirnam/agents` | Agent API — `createAgent`, `AgentProxy`, `createAgentProxy`, etc. |
| `@palinc/nirnam/agents/react` | Agent React hooks |
| `@palinc/nirnam/agents/testing` | `mockLLM`, `scenarioMock` for tests |
| `@palinc/nirnam/vite` | Vite plugin for Layer 3 static worker deployment |
| `@palinc/nirnam/rsbuild` | Rsbuild plugin for Layer 3 static worker deployment |
| `@palinc/nirnam/webpack` | Webpack 5 plugin for Layer 3 static worker deployment |

---

## `createBus(options?)` → `NirnamBus`

Factory function. Returns a new bus instance connected to the SharedWorker.

```ts
const bus = createBus();
const bus = createBus({
  workerUrl: '/nirnam-worker.js',   // Layer 3: static file served at this path
  useBroadcastChannel: false,       // disable cross-tab BroadcastChannel
  requestTimeout: 10_000,           // default request() timeout in ms (default: 5000)
  dispatchDOMEvents: true,          // also fire DataEvent on window for each publish()
});
```

### `NirnamBusOptions`

```ts
interface NirnamBusOptions {
  workerUrl?: string;            // Opt-in static worker URL (Layer 3)
  useBroadcastChannel?: boolean; // Default: true
  requestTimeout?: number;       // Default: 5000 ms
  dispatchDOMEvents?: boolean;   // Default: false
  persistence?: {
    defaultTtl?: number;         // Default TTL for persisted messages, ms. Default: 60 000.
  };
}
```

**`workerUrl`** — The key toggle for cross-tab request-reply. Without it, Nirnam creates a Blob-URL SharedWorker unique per tab (Layer 2 — requests stay within the page). With it, all tabs loading the same static URL share one SharedWorker process (Layer 3 — requests route cross-tab).

### Auto-injection via build plugins

When a build plugin is active, `__NIRNAM_STATIC_WORKER_URL__` is injected at bundle time and `createBus()` picks it up automatically — no `workerUrl` option needed:

```ts
// vite.config.ts
import { nirnamPlugin } from '@palinc/nirnam/vite';
export default { plugins: [nirnamPlugin()] };

// App code — URL auto-injected, no option needed
const bus = createBus(); // uses /nirnam-worker.js automatically
```

Explicit `workerUrl` always takes precedence over the injected global.

---

## Pub/Sub — `publish` / `subscribe`

Fire-and-forget broadcast. All subscribers on the same page receive the payload via the SharedWorker. With Layer 1 active, subscribers on other tabs also receive it.

```ts
// Publisher
bus.publish<CartEvent>('cart:updated', { itemCount: 3, total: 99 });

// Subscriber — returns an unsubscribe function
const unsub = bus.subscribe<CartEvent>('cart:updated', (event) => {
  console.log(event.itemCount); // 3
});
unsub();
```

**Persistence (opt-in):**

```ts
// Persist this message to IndexedDB for late-joining subscribers
bus.publish('my:topic', data, { persist: true, ttl: 30_000 });

// Replay last 10 persisted messages immediately after subscribing
bus.subscribe('my:topic', handler, { replay: 10 });
```

**Guarantees:**
- Publish is fire-and-forget: no confirmation, no error if no subscribers exist.
- A publisher does NOT receive its own messages (SharedWorker deduplicates via `sourcePageId`).
- BroadcastChannel duplicates to other tabs; the SharedWorker routes within-page only.

---

## Request-Reply — `request` / `handle`

Narrow (point-to-point) request-reply. Only one handler per topic at a time — last registered wins.

```ts
// Handler — registers on this bus instance
const unsubHandle = bus.handle<{ userId: string }, UserProfile>(
  'user:getProfile',
  async (payload) => {
    const user = await db.find(payload.userId);
    return user;
  }
);

// Requester — on a different bus instance (different MFE or tab)
const profile = await bus.request<{ userId: string }, UserProfile>(
  'user:getProfile',
  { userId: 'u-123' },
  3000,   // optional timeout override in ms
);
```

### Error handling

`request()` rejects with `NirnamRequestError` in three cases:

```ts
try {
  const result = await bus.request('my:topic', payload);
} catch (err) {
  if (err instanceof NirnamRequestError) {
    switch (err.code) {
      case NirnamErrorCode.TIMEOUT:          break; // no response within timeout
      case NirnamErrorCode.NO_HANDLER:       break; // no handler registered for topic
      case NirnamErrorCode.HANDLER_REJECTED: break; // handler threw
    }
  }
}
```

**Cross-tab routing:** With Layer 3 (static SharedWorker), `request()` / `handle()` route across browser tabs. This is how `AgentProxy` reaches a `scope: 'page'` agent in another tab — the proxy calls `bus.request('${agentId}:__chat', ...)` and the host tab's bus has `bus.handle('${agentId}:__chat', ...)` registered.

**Guarantees:**
- Exactly one handler receives the request.
- Handler errors become `HANDLER_REJECTED` rejections on the requester side.
- Worker uses round-robin when multiple handlers share a topic (from multiple registrations).

---

## Streaming — `requestStream` / `handleStream`

For progressive results (LLM token streaming, data export, search results, etc.).

```ts
// Handler — returns an async generator
const unsubStream = bus.handleStream<{ query: string }, string>(
  'search:results',
  async function* (payload) {
    for await (const hit of searchIndex.stream(payload.query)) {
      yield hit.title;
    }
  }
);

// Consumer — async iterable
for await (const title of bus.requestStream<{ query: string }, string>(
  'search:results',
  { query: 'micro-frontend' },
)) {
  console.log(title);
}
```

**Type signature:**
```ts
handleStream<Req, Res>(topic: string, handler: (payload: Req) => AsyncIterable<Res>): UnsubscribeFn
requestStream<Req, Res>(topic: string, payload: Req): AsyncIterable<Res>
```

**Cross-tab streaming:** With Layer 3, `handleStream` / `requestStream` also work across tabs. `AgentProxy.chatStream()` uses `requestStream('${agentId}:__stream', ...)` to receive token chunks from the host tab.

---

## Agent Service Registry — `register` / `discoverAgents` / `onAgentChange`

The SharedWorker maintains a registry of all connected "agents" (logical services).
Used by `@palinc/nirnam/agents` internally, but also useful for plain bus-based service discovery.

### Register

```ts
bus.register({
  agentId: 'cart-service',
  capabilities: ['cart:getTotal', 'cart:checkout'],
  metadata: { version: '2.1', environment: 'prod' },
});
```

```ts
interface AgentRegistration {
  agentId: string;
  capabilities?: string[];
  metadata?: Record<string, unknown>;
}
```

Registration is automatically removed when the port closes (tab close, `bus.close()`).

For `scope: 'page'` agents, the metadata always includes `{ scope: 'page' }`. Other tabs can discover this and use `createAgentProxy()` to call it.

### Discover (one-shot snapshot)

```ts
const agents: AgentRegistration[] = await bus.discoverAgents();
// [ { agentId: 'my-agent', capabilities: [...], metadata: { scope: 'page' } }, ... ]

// Find a page-scoped agent to proxy
const pageAgents = agents.filter(a => a.metadata?.scope === 'page');
```

### Watch (live updates)

```ts
const unsub = bus.onAgentChange((event: AgentChangeEvent) => {
  if (event.type === 'join') console.log('joined:', event.agent.agentId);
  else console.log('left:', event.agentId);
});
```

```ts
type AgentChangeEvent =
  | { type: 'join'; agent: AgentRegistration }
  | { type: 'leave'; agentId: string };
```

---

## IndexedDB Message Persistence

```ts
// Persist messages at publish-time (opt-in per-publish)
bus.publish('my:topic', data, { persist: true, ttl?: number });

// Replay last N messages on subscribe (received immediately after subscribing)
bus.subscribe('my:topic', handler, { replay: 10 });
```

- Each persisted message gets a UUID `messageId` as IDB primary key.
- Duplicate `put()` calls for the same `messageId` are idempotent — safe for cross-tab deduplication.
- Expired records are pruned asynchronously after every write (no background timers).
- IDB schema: `nirnam-persistence-v1` / `messages` store, indexed by `topic` and `expiresAt`.

> **Separate from agent history persistence:** `scope: 'page'` agents persist their conversation history in a different IDB database: `nirnam-agent-history-v1` / `histories` store.

---

## Layer 3 Static Worker Build Plugins

### Why Layer 3?

Without a build plugin, each tab's `createBus()` creates a unique Blob-URL SharedWorker. Blob URLs are per-tab, so different tabs get different worker processes — cross-tab `request()` / `handle()` fails.

With a build plugin, all tabs load the worker from the same static URL. The browser shares the single process across tabs, enabling cross-tab request-reply and streaming.

### `@palinc/nirnam/vite`

```ts
// vite.config.ts
import { nirnamPlugin } from '@palinc/nirnam/vite';

export default {
  plugins: [nirnamPlugin()],
  // or with custom path:
  plugins: [nirnamPlugin({ workerPath: 'workers/bus.js' })],
};
```

What it does:
1. Copies the bundled worker source to `<publicDir>/nirnam-worker.js` (configurable).
2. Injects `__NIRNAM_STATIC_WORKER_URL__ = "/nirnam-worker.js"` via Vite's `define`.

```ts
export interface NirnamPluginOptions {
  workerPath?: string;  // Default: 'nirnam-worker.js'. Relative to publicDir.
}

export function nirnamPlugin(options?: NirnamPluginOptions): Plugin
```

### `@palinc/nirnam/rsbuild`

```ts
// rsbuild.config.ts
import { nirnamRsbuildPlugin } from '@palinc/nirnam/rsbuild';

export default defineConfig({
  plugins: [nirnamRsbuildPlugin()],
});
```

What it does:
1. Injects `__NIRNAM_STATIC_WORKER_URL__` via `source.define`.
2. Copies the worker to `<root>/public/nirnam-worker.js` on both build and dev-server start.

### `@palinc/nirnam/webpack`

```js
// webpack.config.js
const { NirnamWebpackPlugin } = require('@palinc/nirnam/webpack');

module.exports = {
  plugins: [new NirnamWebpackPlugin()],
  // or:
  plugins: [new NirnamWebpackPlugin({ workerPath: 'workers/bus.js' })],
};
```

What it does:
1. Applies an internal `DefinePlugin` to inject `__NIRNAM_STATIC_WORKER_URL__`.
2. Emits the worker source as a Webpack compilation asset via `compilation.emitAsset()`.

### How the build-time injection works

`bus.ts` declares `__NIRNAM_STATIC_WORKER_URL__: string | undefined` as an ambient global:

```ts
declare const __NIRNAM_STATIC_WORKER_URL__: string | undefined;
```

`resolveWorkerUrl()` checks it in priority order:
1. Explicit `workerUrl` option passed to `createBus()`.
2. `__NIRNAM_STATIC_WORKER_URL__` injected at build time by a plugin.
3. Blob URL fallback (Layer 2).

Without a plugin, the identifier stays `undefined` at runtime — Layer 2 behaviour is unchanged.

---

## Lifecycle — `close()`

Always call `close()` when a bus instance is no longer needed:

```ts
bus.close();
// Closes the SharedWorker port and BroadcastChannel.
// All pending requests are dropped (not rejected).
// Any registered handlers are removed.
```

In an MFE:
```ts
const bus = createBus();
window.addEventListener('beforeunload', () => bus.close(), { once: true });
```

In React:
```ts
const bus = useMemo(() => createBus(), []);
useEffect(() => () => bus.close(), [bus]);
```

---

## React integration — `@palinc/nirnam/react`

```ts
import {
  NirnamProvider,
  useNirnam,
  useNirnamPublish,
  useNirnamRequest,
} from '@palinc/nirnam/react';
```

### `NirnamProvider`

```tsx
const bus = useMemo(() => createBus(), []);
useEffect(() => () => bus.close(), [bus]);

return (
  <NirnamProvider bus={bus}>
    <App />
  </NirnamProvider>
);
```

### `useNirnam<T>(topic, initialValue?)` → `T | undefined`

Subscribes to a topic and returns the latest received value. Auto-unsubscribes on unmount.

```tsx
const cartTotal = useNirnam<number>('cart:total', 0);
```

### `useNirnamPublish()` → `(topic, payload) => void`

```tsx
const publish = useNirnamPublish();
publish('user:logout', { reason: 'timeout' });
```

### `useNirnamRequest<Req, Res>()` → `(topic, payload, timeout?) => Promise<Res>`

```tsx
const request = useNirnamRequest<void, User[]>();
const users = await request('users:list', undefined, 5000);
```

---

## MCP Transport — `@palinc/nirnam/mcp`

Adapts the Nirnam bus as an MCP-compatible `Transport`.

```ts
import { NirnamMCPTransport } from '@palinc/nirnam/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
```

### Server (tool provider)

```ts
const bus = createBus();
const server = new McpServer({ name: 'calc-agent', version: '1.0.0' });

server.tool('add', { a: z.number(), b: z.number() }, async ({ a, b }) => ({
  content: [{ type: 'text', text: String(a + b) }],
}));

const transport = new NirnamMCPTransport({ agentId: 'calc-agent', bus });
await server.connect(transport);
```

### Client (orchestrator)

```ts
const bus = createBus();
const client = new Client({ name: 'orchestrator', version: '1.0.0' });

const transport = new NirnamMCPTransport({
  agentId: 'orchestrator',
  targetAgentId: 'calc-agent',
  bus,
});
await client.connect(transport);

const result = await client.callTool('add', { a: 3, b: 4 });
```

### `NirnamMCPTransportOptions`

```ts
interface NirnamMCPTransportOptions {
  agentId: string;           // This instance's ID — listens on `mcp:<agentId>`
  targetAgentId?: string;    // Sends to `mcp:<targetAgentId>`. Required for clients.
  bus: NirnamBus;
}
```

---

## `DataEvent` — DOM event bridge (opt-in)

When `dispatchDOMEvents: true` is passed to `createBus()`, every `publish()` also fires a `DataEvent<T>` on `window`.

```ts
import { DataEvent, RequestType } from '@palinc/nirnam';

window.addEventListener(RequestType.BROAD, (e) => {
  const event = e as DataEvent<unknown>;
  console.log(event.topic, event.detail);
});
```

---

## Types reference

```ts
// Core
type UnsubscribeFn = () => void;
type SubscribeHandler<T = unknown> = (payload: T) => void;
type RequestHandler<Req = unknown, Res = unknown> = (payload: Req) => Res | Promise<Res>;
type StreamHandler<Req = unknown, Res = unknown> = (payload: Req) => AsyncIterable<Res>;

// Options
interface NirnamBusOptions {
  workerUrl?: string;
  useBroadcastChannel?: boolean;   // default true
  requestTimeout?: number;          // default 5000
  dispatchDOMEvents?: boolean;      // default false
  persistence?: { defaultTtl?: number };  // default 60 000
}

interface PublishOptions {
  persist?: boolean;   // Persist to IDB (default: false)
  ttl?: number;        // TTL in ms; overrides bus-level default
}

interface SubscribeOptions {
  replay?: number;     // Replay last N persisted messages on subscribe
}

// Errors
enum NirnamErrorCode { NO_HANDLER, HANDLER_REJECTED, TIMEOUT, STREAM_ABORTED }
class NirnamRequestError extends Error {
  code: NirnamErrorCode;
}

// Agent registry
interface AgentRegistration {
  agentId: string;
  capabilities?: string[];
  metadata?: Record<string, unknown>;  // scope:'page' agents include { scope: 'page' }
}
type AgentChangeEvent =
  | { type: 'join'; agent: AgentRegistration }
  | { type: 'leave'; agentId: string };
type AgentChangeHandler = (event: AgentChangeEvent) => void;

// DOM event bridge
enum RequestType { BROAD = 'broad', NARROW = 'narrow' }
```

---

## `NirnamBus` method summary

| Method | Returns | Description |
|--------|---------|-------------|
| `publish<T>(topic, payload, opts?)` | `void` | Broadcast to all subscribers |
| `subscribe<T>(topic, handler, opts?)` | `UnsubscribeFn` | Receive broadcasts; `opts.replay` replays persisted |
| `handle<Req, Res>(topic, handler)` | `UnsubscribeFn` | Register request handler |
| `request<Req, Res>(topic, payload, timeout?)` | `Promise<Res>` | Send request, await reply |
| `handleStream<Req, Res>(topic, handler)` | `UnsubscribeFn` | Register streaming handler |
| `requestStream<Req, Res>(topic, payload)` | `AsyncIterable<Res>` | Consume streaming response |
| `register(registration)` | `void` | Announce this service |
| `discoverAgents()` | `Promise<AgentRegistration[]>` | Snapshot of registered services |
| `onAgentChange(handler)` | `UnsubscribeFn` | Live join/leave events |
| `close()` | `void` | Destroy port + channel |

---

## Common patterns

### Module-level singleton (MFE pattern)

```ts
// services/bus.ts — one file per MFE bundle
export const bus = createBus();
```

### Cross-tab pub/sub (Layer 1)

```ts
// Works across browser tabs automatically (useBroadcastChannel: true default).
bus.publish('tab:focus', { tabId: PAGE_ID });
bus.subscribe('tab:focus', ({ tabId }) => { /* another tab just focused */ });
```

### Cross-tab request-reply (Layer 3)

```ts
// Enable Layer 3 via a build plugin (nirnamPlugin for Vite), then:
const bus = createBus(); // auto-uses /nirnam-worker.js

// Tab A — host
bus.handle('data:query', async ({ sql }) => await db.query(sql));

// Tab B — client (same origin, same static worker URL)
const rows = await bus.request('data:query', { sql: 'SELECT * FROM users' });
```

### Cross-tab agent proxy (Layer 3 + scope: 'page')

```ts
// Tab A — host (owns the real agent)
import { createAgent } from '@palinc/nirnam/agents';
const agent = createAgent({ agentId: 'my-agent', scope: 'page', llm, bus });
await agent.ready;

// Tab B — client
import { createAgentProxy } from '@palinc/nirnam/agents';
const proxy = createAgentProxy('my-agent', bus);
const reply = await proxy.chat('Hello!');
for await (const chunk of proxy.chatStream('Tell me a story')) {
  process.stdout.write(chunk);
}
```

### Request-reply service

```ts
// In service A
bus.register({ agentId: 'auth-service', capabilities: ['auth:verify'] });
bus.handle<{ token: string }, { valid: boolean; userId?: string }>(
  'auth:verify',
  async ({ token }) => ({ valid: await jwt.verify(token), userId: jwt.decode(token)?.sub }),
);

// In service B (different MFE or tab with Layer 3)
const { valid, userId } = await bus.request('auth:verify', { token });
```

### Late-join replay with persistence

```ts
// Publisher — mark messages for persistence
bus.publish('sensor:reading', { temp: 72.4 }, { persist: true, ttl: 60_000 });

// Late subscriber — receives last 5 readings immediately on subscribe
bus.subscribe('sensor:reading', handler, { replay: 5 });
```
