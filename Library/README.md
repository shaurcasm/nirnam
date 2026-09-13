# @palinc/nirnam

A message bus for micro-frontend communication and browser-native AI agents — routed through a Web Worker, fanned out across tabs with BroadcastChannel, zero runtime dependencies.

## Install

```bash
npm install @palinc/nirnam
```

## Quick start

```ts
import { createBus } from '@palinc/nirnam';

const bus = createBus();

// Subscribe
bus.subscribe<string>('greet', msg => console.log(msg));

// Publish
bus.publish('greet', 'Hello from another MFE!');
```

That's it. No server, no config, no boilerplate. Works across iframes, Module Federation remotes, and independently-loaded scripts on the same page.

---

## Core message patterns

### Pub / Sub

Fire-and-forget broadcast. Any number of subscribers receive every message.

```ts
const unsub = bus.subscribe<{ user: string }>('user:login', ({ user }) => {
  console.log('logged in:', user);
});

bus.publish('user:login', { user: 'alice' });

unsub(); // stop listening
```

### Request / Reply

One sender, one handler, typed generics, built-in timeout.

```ts
// In the service MFE
bus.handle<{ id: number }, { name: string }>('product:get', async ({ id }) => {
  return { name: await db.getProductName(id) };
});

// In the consumer MFE
const product = await bus.request<{ id: number }, { name: string }>(
  'product:get',
  { id: 42 }
);
```

### Streaming

Push a sequence of values from handler to consumer — perfect for LLM token streams or progress updates.

```ts
// Handler
bus.handleStream<{ prompt: string }, string>('llm:stream', async function* ({ prompt }) {
  for await (const token of llm.stream(prompt)) {
    yield token;
  }
});

// Consumer
for await (const token of bus.requestStream<{ prompt: string }, string>('llm:stream', { prompt: 'Hello' })) {
  process.stdout.write(token);
}
```

---

## React integration

```bash
# no extra install — included in @palinc/nirnam
```

```tsx
import { NirnamProvider, useNirnam, useNirnamPublish } from '@palinc/nirnam/react';
import { createBus } from '@palinc/nirnam';

const bus = createBus();

function App() {
  return (
    <NirnamProvider bus={bus}>
      <Counter />
      <Controls />
    </NirnamProvider>
  );
}

function Counter() {
  const count = useNirnam<number>('counter', 0);
  return <div>Count: {count}</div>;
}

function Controls() {
  const publish = useNirnamPublish();
  return <button onClick={() => publish('counter', c => c + 1)}>+1</button>;
}
```

**All React hooks:**

| Hook | Returns |
|------|---------|
| `useNirnam<T>(topic, initial?)` | Latest value on that topic |
| `useNirnamPublish()` | Stable `publish(topic, payload)` function |
| `useNirnamRequest()` | Stable `request(topic, payload, timeout?)` function |
| `useNirnamRequestStream()` | Stable `requestStream(topic, payload)` function |
| `useNirnamBus()` | Raw `NirnamBus` instance |

---

## Angular integration

```ts
import { provideNirnam, NirnamService } from '@palinc/nirnam/angular';

// main.ts (standalone)
bootstrapApplication(AppComponent, {
  providers: [provideNirnam()]
});

// or NgModule
@NgModule({
  imports: [NirnamModule.forRoot()]
})
```

```ts
@Component({ ... })
export class MyComponent {
  private nirnam = inject(NirnamService);

  count$ = this.nirnam.subscribe<number>('counter');

  increment() {
    this.nirnam.publish('counter', 42);
  }
}
```

---

## Agent framework

Build LLM-powered agents that run entirely in the browser — no backend required.

```ts
import { createAgent } from '@palinc/nirnam/agents';

const agent = createAgent({
  agentId: 'assistant',
  llm: {
    url: 'http://localhost:11434/api/chat', // Ollama
    model: 'llama3.2',
  },
  systemPrompt: 'You are a helpful assistant.',
  bus,
});

await agent.ready;

// Back-and-forth conversation (history accumulates)
const reply = await agent.chat('What is the capital of France?');

// One-shot task (history is not modified)
const summary = await agent.run('Summarise this text: ...');

// Single LLM call, no tool loop
const label = await agent.process('Classify: positive or negative? "Great product!"');

// Streaming
for await (const token of agent.chatStream('Tell me a story')) {
  process.stdout.write(token);
}
```

**LLM auto-detection** — no provider flag needed. The URL decides:

| URL pattern | Provider |
|-------------|----------|
| `localhost:11434` | Ollama |
| `*.anthropic.com` or `claude-*` model | Anthropic |
| Anything else with `/v1/chat/completions` | OpenAI-compatible |

### Built-in tools

```ts
import { presets } from '@palinc/nirnam/agents';

const agent = createAgent({
  agentId: 'coder',
  llm: { url: '...', model: '...' },
  ...presets.filesystem(), // adds readFile / listDirectory / writeFile tools
  bus,
});

// User picks a folder — agent can read/write it
await agent.requestFolderAccess();
```

Available presets: `filesystem()`, `codeReview()`, `summarizer()`, `monitor()`.

### React hooks for agents

```tsx
import { useAgent, useAgentChat } from '@palinc/nirnam/agents/react';

function Chat() {
  const agent = useAgent({ agentId: 'assistant', llm: { url: '...', model: '...' }, bus });
  const { messages, send, isStreaming } = useAgentChat(agent);

  return (
    <>
      {messages.map(m => <div key={m.id}>[{m.role}] {m.content}</div>)}
      <button onClick={() => send('Hello!')} disabled={isStreaming}>Send</button>
    </>
  );
}
```

### Multi-agent topologies

```ts
import { createAgent, connectAgents } from '@palinc/nirnam/agents';

const extractor = createAgent({ agentId: 'extractor', llm, bus });
const summariser = createAgent({ agentId: 'summariser', llm, bus });

// Output of extractor becomes input of summariser
connectAgents([extractor, summariser], {
  topology: 'pipeline',
  topic: 'pipeline:data',
});
```

### Testing agents

```ts
import { mockLLM } from '@palinc/nirnam/agents/testing';

const agent = createAgent({
  agentId: 'test-agent',
  llm: mockLLM(['First reply', 'Second reply']),
  bus,
});
```

---

## MCP Transport

Wire any MCP-compatible server or client over the Nirnam bus. No HTTP, no WebSocket — message routing is handled by the hub worker.

```ts
import { NirnamMCPTransport } from '@palinc/nirnam/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

// Install peer dep: npm install @modelcontextprotocol/sdk

const transport = new NirnamMCPTransport({
  agentId: 'mcp-client',
  targetAgentId: 'mcp-server',
  bus,
});

const client = new Client({ name: 'my-client', version: '1.0.0' }, { capabilities: {} });
await client.connect(transport);

const result = await client.callTool({ name: 'my_tool', arguments: {} });
```

---

## Where the hub runs

Every bus on a page connects to a **hub** — the subscriber registry and router. `createBus({ hub })` chooses where it lives:

| `hub` | Runs in | Reach | When to pick it |
|---|---|---|---|
| `'dedicated'` (default) | a Worker owned by this page | every script on this page | always, unless you need one of the other two — every browser has it, including Chrome on Android, and it terminates with the page |
| `'shared'` | a SharedWorker | every tab of the origin | cross-tab request-reply and `scope: 'page'` agents; falls back to `'dedicated'` with a warning where SharedWorker is missing |
| `'inline'` | this thread | every bus in this module | tests, SSR, and anywhere workers are unavailable — zero hops, nothing to start |

`publish()` reaches other tabs through BroadcastChannel whatever the hub is; only request-reply and agent discovery are scoped to the hub.

```ts
const bus = createBus();                    // dedicated worker
const bus = createBus({ hub: 'shared' });   // cross-tab
const bus = createBus({ hub: 'inline' });   // tests
bus.hub;                                    // what you actually got, after fallback
bus.close();                                // leaves the hub; the last close terminates a dedicated worker
```

### Letting a worker join the bus

A dedicated worker of your own — animation, audio analysis — cannot create a bus, but it can be handed a port to the hub. From then on its traffic never crosses the main thread:

```ts
// main thread
const worker = new Worker(new URL('./render.worker', import.meta.url), { type: 'module' });
bus.adoptWorker(worker);

// render.worker.ts
import { connectWorkerBus } from '@palinc/nirnam/worker';
const bus = await connectWorkerBus();      // resolves when the page hands over the port
bus.subscribe('theme:changed', repaint);
bus.handle('render:stats', () => stats);
```

`adoptWorker` is `adoptPort` plus the handshake: it creates a `MessageChannel`, gives the hub one end and posts the other to the worker in a `nirnam:connect` message. A worker bus has everything but a BroadcastChannel — its reach is the hub, not other tabs.

## Off-main-thread animation

`@palinc/nirnam/canvas` draws animated surfaces into `OffscreenCanvas`es from a dedicated worker, so the main thread — UI, sockets, agents — never pays for a frame. One orchestrator runs one `requestAnimationFrame` for every surface; the worker joins the bus for state at event frequency; pointer input, sizes and visibility go over the worker's own port, batched to one message per frame.

```ts
// ambient.worker.ts
import { connectWorkerBus } from '@palinc/nirnam/worker';
import { createOrchestrator } from '@palinc/nirnam/canvas';
import type { Surface } from '@palinc/nirnam/canvas';

class Leaves implements Surface {
  attach(canvas, size) { this.ctx = canvas.getContext('2d'); }
  frame(dt, { pointer, size, tier }) { /* draw */ }
}

const orchestrator = createOrchestrator({ surfaces: { leaves: () => new Leaves() } });
const bus = await connectWorkerBus();
bus.subscribe('theme:changed', theme => orchestrator.setState('leaves', theme));
```

```tsx
// main thread
import { CanvasHost, useSurface } from '@palinc/nirnam/canvas/react';
import { resolveMotionTier, probeMotionCapabilities } from '@palinc/nirnam/canvas';

const tier = resolveMotionTier(probeMotionCapabilities(), userPreference); // 'full' | 'ambient' | 'off'

<CanvasHost worker={() => new Worker(new URL('./ambient.worker', import.meta.url), { type: 'module' })} tier={tier} bus={bus}>
  <Background />
</CanvasHost>

function Background() {
  const ref = useSurface('leaves');
  return <canvas ref={ref} aria-hidden style={{ position: 'fixed', inset: 0, pointerEvents: 'none' }} />;
}
```

Three tiers, probed at runtime: `full` (60 fps, pointer-reactive), `ambient` (30 fps, lower DPR, no pointer — low-end or touch devices) and `off` (no worker is even started; `useMotionTier()` lets a component render a static fallback). `prefers-reduced-motion` always wins. The orchestrator reports per-surface frame timing once a second (`onStats`) and steps itself down from `full` to `ambient` after sustained overrun (`onTierChange`). `transferControlToOffscreen()` is one-shot per element, and the host survives React StrictMode's double mount. Without React, `CanvasHostController` is the same thing as a class.

What it costs, and how to keep it small: the compositor pays **per canvas per frame**, however little was drawn, so put several things on one canvas with `layers({ sky: …, tree: …, leaves: … })` rather than one canvas each, and cap a full-viewport background with `useSurface(id, { maxDpr: 1 })` — nobody sees the second pixel. The loop stops when the page is hidden (worker `requestAnimationFrame` would not stop by itself in a background tab), when a surface scrolls out of view, and when nothing is attached.

Example: `Examples/canvas/`.

## Static worker URL

By default the hub worker loads from a Blob URL. Two reasons to serve it as a static file instead: a strict `worker-src` CSP that forbids `blob:`, and the `'shared'` hub, which can only be shared across tabs when every tab loads the same URL. The build plugins do that:

### Vite

```ts
// vite.config.ts
import { nirnamPlugin } from '@palinc/nirnam/vite';

export default {
  plugins: [nirnamPlugin()]
};
```

### Rsbuild

```ts
// rsbuild.config.ts
import { nirnamPlugin } from '@palinc/nirnam/rsbuild';

export default defineConfig({
  plugins: [nirnamPlugin()]
});
```

### Webpack

```ts
// webpack.config.js
const { NirnamWebpackPlugin } = require('@palinc/nirnam/webpack');

module.exports = {
  plugins: [new NirnamWebpackPlugin()]
};
```

Each plugin copies the worker script into your public directory and injects `__NIRNAM_STATIC_WORKER_URL__` at build time. `createBus()` picks it up automatically — no code changes needed.

### Cross-tab agents

Run one LLM agent in a host tab and let any other tab proxy into it. This needs the `'shared'` hub on a static URL:

```ts
// host tab
import { createAgent } from '@palinc/nirnam/agents';

const bus = createBus({ hub: 'shared' });
const agent = createAgent({
  agentId: 'assistant',
  scope: 'page',   // registers in the shared hub's registry
  llm: { url: '...', model: '...' },
  bus,
});
```

```ts
// any other tab
import { createAgentProxy } from '@palinc/nirnam/agents';

const proxy = createAgentProxy('assistant', bus);

const reply = await proxy.chat('Hello!'); // routed to the host tab
```

---

## Message persistence

Replay messages to late-joining subscribers using IndexedDB.

```ts
// Publisher
bus.publish('notifications', { text: 'Server restarted' }, { persist: true, ttl: 60_000 });

// Subscriber (gets last 10 messages immediately on subscribe)
bus.subscribe('notifications', handler, { replay: 10 });
```

---

## TypeScript

The package ships `.d.ts` declaration files for every subpath export. No `@types` package required.

```ts
import type { NirnamBus, NirnamBusOptions, AgentConfig, AgentStatus } from '@palinc/nirnam';
import type { NirnamMCPTransport } from '@palinc/nirnam/mcp';
```

---

## Browser support

Requires **Web Workers**, **MessageChannel** and **BroadcastChannel** (all modern browsers, Chrome on Android included; no IE11). The `'shared'` hub additionally needs **SharedWorker** — absent on Chrome for Android — and falls back to `'dedicated'` without it. The agent framework additionally uses `fetch` for LLM calls and optionally the **File System Access API** for folder tools.

---

## Subpath exports

| Import | Contents |
|--------|----------|
| `@palinc/nirnam` | `createBus`, `NirnamBus`, `DataEvent`, `MessageHub` |
| `@palinc/nirnam/worker` | `connectWorkerBus`, `createWorkerBus` — the bus inside your own dedicated worker |
| `@palinc/nirnam/canvas` | `createOrchestrator`, `CanvasHostController`, `resolveMotionTier`, `probeMotionCapabilities`, `Surface` |
| `@palinc/nirnam/canvas/react` | `CanvasHost`, `useSurface`, `useMotionTier` |
| `@palinc/nirnam/react` | `NirnamProvider`, `useNirnam`, `useNirnamPublish`, … |
| `@palinc/nirnam/angular` | `NirnamService`, `provideNirnam`, `NirnamModule` |
| `@palinc/nirnam/agents` | `createAgent`, `createAgentProxy`, `connectAgents`, `presets` |
| `@palinc/nirnam/agents/react` | `useAgent`, `useAgentChat`, `useAgentStatus` |
| `@palinc/nirnam/agents/testing` | `mockLLM` |
| `@palinc/nirnam/mcp` | `NirnamMCPTransport` |
| `@palinc/nirnam/vite` | `nirnamPlugin` |
| `@palinc/nirnam/rsbuild` | `nirnamPlugin` |
| `@palinc/nirnam/webpack` | `NirnamWebpackPlugin` |
