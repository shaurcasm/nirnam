# @palinc/nirnam — Transport Layer Context

> Authoritative reference for the core Nirnam bus, MCP transport, React integration, and all exported types.
> Generated from source — keep in sync with `Library/src/`.

---

## Architecture overview

Nirnam runs a **three-layer hybrid message bus** in every browser context that imports it.

| Layer | Mechanism | Scope | Routing features |
|-------|-----------|-------|-----------------|
| 1 | `BroadcastChannel` | Cross-tab, same origin | Pub/sub fan-out only |
| 2 | Blob-URL `SharedWorker` | Within-page (all bundles on the same tab) | Pub/sub, request-reply, streaming, agent registry |
| 3 | Static-URL `SharedWorker` (opt-in) | True cross-tab + same page | All features, persists across tabs |

`createBus()` defaults to Layer 1 + 2. Pass `workerUrl` to activate Layer 3.

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
| `@palinc/nirnam/agents` | Agent API (see NIRNAM_AGENTS_CONTEXT.md) |
| `@palinc/nirnam/agents/react` | Agent React hooks |
| `@palinc/nirnam/agents/testing` | `mockLLM`, `scenarioMock` for tests |

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
}
```

**`workerUrl`** — The key toggle for cross-tab support. Without it, Nirnam creates a Blob-URL SharedWorker that is unique per tab (Layer 2). With it, all tabs loading the same static URL share the same SharedWorker process (Layer 3).

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

// Later — always clean up
unsub();
```

**Guarantees:**
- Publish is fire-and-forget: no confirmation, no error if no subscribers exist.
- A publisher does NOT receive its own messages (SharedWorker deduplicates via `sourcePageId`).
- BroadcastChannel duplicates to other tabs; the SharedWorker routes within-page only.
- Handlers are called synchronously within the SharedWorker's message event; throw inside a handler does not propagate to the publisher.

---

## Request-Reply — `request` / `handle`

Narrow (point-to-point) request-reply. Only one handler per topic is supported — last registered wins.

```ts
// Handler — registers on this bus instance
const unsubHandle = bus.handle<{ userId: string }, UserProfile>(
  'user:getProfile',
  async (payload) => {
    const user = await db.find(payload.userId);
    return user;   // returned value is sent back to requester
  }
);

// Requester — on a different bus instance (different MFE)
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
      case NirnamErrorCode.TIMEOUT:
        // No response within timeout window
        break;
      case NirnamErrorCode.NO_HANDLER:
        // Topic exists but no handler is registered
        break;
      case NirnamErrorCode.HANDLER_REJECTED:
        // Handler threw an error
        break;
    }
  }
}
```

**Guarantees:**
- Exactly one handler receives the request — the most recently registered one for that topic.
- `handle()` returns an unsubscribe function that deregisters the handler.
- If the handler is async, the response is sent when the promise resolves.
- Handler errors become `HANDLER_REJECTED` rejections on the requester side.

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

**Guarantees:**
- Handler must return an `AsyncIterable` (plain async generator functions satisfy this).
- Backpressure is not applied — chunks are queued on the consumer side.
- If the handler throws mid-stream, the consumer's `for await` loop rejects.
- One handler per topic (same as `handle`).

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

### Discover (one-shot snapshot)

```ts
const agents: AgentRegistration[] = await bus.discoverAgents();
// [ { agentId: 'cart-service', capabilities: [...] }, ... ]
```

### Watch (live updates)

```ts
const unsub = bus.onAgentChange((event: AgentChangeEvent) => {
  if (event.type === 'join') {
    console.log('joined:', event.agent.agentId);
  } else {
    console.log('left:', event.agentId);
  }
});
```

```ts
type AgentChangeEvent =
  | { type: 'join'; agent: AgentRegistration }
  | { type: 'leave'; agentId: string };
```

The first call to `onAgentChange` sends a `watch-agents` message to the worker, which starts streaming join/leave events until the port closes or all watchers unsubscribe.

---

## Lifecycle — `close()`

Always call `close()` when a bus instance is no longer needed:

```ts
bus.close();
// Closes the SharedWorker port and BroadcastChannel.
// All pending requests are dropped (not rejected).
// Any registered handlers are removed.
```

In an MFE, tie the bus to the module lifetime:

```ts
// Module-level singleton (one per MFE bundle)
const bus = createBus();

// Cleanup when the MFE unloads
window.addEventListener('beforeunload', () => bus.close(), { once: true });
```

In a React component:

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

Wraps a subtree with a bus instance. All hooks below require this provider.

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

Subscribes to a topic and returns the latest received value. Re-renders on each new message. Auto-unsubscribes on unmount.

```tsx
const cartTotal = useNirnam<number>('cart:total', 0);
// Updates whenever any bus publishes to 'cart:total'
```

### `useNirnamPublish()` → `(topic, payload) => void`

Returns a stable publish function bound to the provider's bus.

```tsx
const publish = useNirnamPublish();
// publish('user:logout', { reason: 'timeout' });
```

### `useNirnamRequest<Req, Res>()` → `(topic, payload, timeout?) => Promise<Res>`

Returns a stable request function bound to the provider's bus.

```tsx
const request = useNirnamRequest<void, User[]>();
const users = await request('users:list', undefined, 5000);
```

---

## MCP Transport — `@palinc/nirnam/mcp`

Adapts the Nirnam bus as an MCP-compatible `Transport`, allowing MCP servers and clients to communicate via the SharedWorker without a network socket.

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

const transport = new NirnamMCPTransport({
  agentId: 'calc-agent',   // Listens on topic mcp:calc-agent
  bus,
});
await server.connect(transport);
```

### Client (orchestrator)

```ts
const bus = createBus();
const client = new Client({ name: 'orchestrator', version: '1.0.0' });

const transport = new NirnamMCPTransport({
  agentId: 'orchestrator',          // Client's own ID (receives responses on mcp:orchestrator)
  targetAgentId: 'calc-agent',      // Sends requests to mcp:calc-agent
  bus,
});
await client.connect(transport);

const result = await client.callTool('add', { a: 3, b: 4 });
```

### `NirnamMCPTransportOptions`

```ts
interface NirnamMCPTransportOptions {
  agentId: string;           // This instance's ID — listens on topic `mcp:<agentId>`
  targetAgentId?: string;    // Send to `mcp:<targetAgentId>`. Required for clients.
                             // Optional for servers (auto-replies to last sender).
  bus: NirnamBus;
}
```

**How routing works:** Messages are published to `mcp:<targetAgentId>` and received via `subscribe('mcp:<agentId>', ...)`. The server uses the `from` field in the envelope to know which client to reply to, enabling one server to serve multiple clients simultaneously.

**Peer dep:** `@modelcontextprotocol/sdk` is optional. `NirnamMCPTransport` is structurally compatible but does not import from the SDK directly.

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

`DataEvent<T>` extends `CustomEvent<T>` with an extra `topic: string` property. Useful for bridging to non-Nirnam code or legacy event listeners.

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
  metadata?: Record<string, unknown>;
}
type AgentChangeEvent =
  | { type: 'join'; agent: AgentRegistration }
  | { type: 'leave'; agentId: string };
type AgentChangeHandler = (event: AgentChangeEvent) => void;

// Internal message (not normally needed by consumers)
interface NirnamMessage<T = unknown> {
  type: NirnamMessageType;
  topic?: string;
  payload?: T;
  requestId?: string;
  sourcePageId?: string;
  error?: string;
  code?: NirnamErrorCode;
  agentId?: string;
  capabilities?: string[];
  metadata?: Record<string, unknown>;
  agents?: AgentRegistration[];
  agent?: AgentRegistration;
}

// Enum: RequestType — used for dispatchDOMEvents & DataEvent
enum RequestType { BROAD = 'broad', NARROW = 'narrow' }
```

---

## `NirnamBus` method summary

| Method | Returns | Description |
|--------|---------|-------------|
| `publish<T>(topic, payload)` | `void` | Broadcast to all subscribers |
| `subscribe<T>(topic, handler)` | `UnsubscribeFn` | Receive broadcasts |
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

All components in the MFE import from this file. The bus is created once and lives for the MFE's lifetime.

### Request-reply service

```ts
// In service A
bus.register({ agentId: 'auth-service', capabilities: ['auth:verify'] });
bus.handle<{ token: string }, { valid: boolean; userId?: string }>(
  'auth:verify',
  async ({ token }) => ({ valid: await jwt.verify(token), userId: jwt.decode(token)?.sub }),
);

// In service B (different MFE)
const { valid, userId } = await bus.request('auth:verify', { token });
```

### Coordinated shutdown (typed events)

```ts
bus.publish<{ reason: string }>('app:shutdown', { reason: 'deploy' });
bus.subscribe<{ reason: string }>('app:shutdown', ({ reason }) => {
  cleanup(reason);
});
```

### Cross-tab pub/sub (Layer 1)

```ts
// Works across browser tabs automatically when useBroadcastChannel is true (default).
// No extra configuration needed — just publish/subscribe as usual.
bus.publish('tab:focus', { tabId: PAGE_ID });
bus.subscribe('tab:focus', ({ tabId }) => { /* another tab just focused */ });
```

### Cross-tab service discovery (Layer 3)

```ts
// Serve the bundled SharedWorker at a static URL (e.g. via Vite/Webpack plugin).
// Both tabs create a bus with the same workerUrl to share the worker process.
const bus = createBus({ workerUrl: '/nirnam-worker.js' });

// Now request() and handle() work cross-tab too.
```
