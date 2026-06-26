# Nirnam

A three-layer hybrid message bus for micro-frontend communication and browser-native AI agents.

**[npm package →](https://www.npmjs.com/package/@palinc/nirnam)**

---

## What it does

Nirnam gives every script on a page — Module Federation remotes, iframes, Web Workers, plain `<script>` tags — a shared message bus without a backend. It handles pub/sub, request-reply, streaming, agent registration, and MCP transport, all routed through a SharedWorker.

**Three layers, one API:**

| Layer | Mechanism | Scope |
|-------|-----------|-------|
| 1 | BroadcastChannel | Cross-tab fan-out (fire-and-forget pub/sub) |
| 2 | Blob-URL SharedWorker | Within-page registry, routing, request-reply, streaming |
| 3 | Static-URL SharedWorker | True cross-tab routing via build plugins (opt-in) |

You always call `createBus()` — Nirnam picks the right layer automatically.

---

## Install

```bash
npm install @palinc/nirnam
```

**[Full usage guide and API reference →](Library/README.md)**

---

## Thirty-second example

```ts
import { createBus } from '@palinc/nirnam';

const bus = createBus();

// One MFE handles cart requests
bus.handle('cart:total', async ({ items }) => {
  return { total: items.reduce((s, i) => s + i.price, 0) };
});

// Another MFE calls it
const { total } = await bus.request('cart:total', { items: [{ price: 9.99 }] });
```

---

## What's in this repo

```
Library/         @palinc/nirnam source + tests
Examples/
  transport/               pub/sub · request-reply · streaming basics (Vite)
  transport-with-persistence/  message replay via IndexedDB (Rsbuild)
  react-mfe/               two React MFEs sharing state (Module Federation)
  agents/                  chat · filesystem · pipeline agents (Rsbuild)
  cross-tab-agent/         host tab runs LLM; other tabs proxy via bus (Vite)
  mcp-agent/               Document Q&A with MCP servers + Ollama (Rsbuild + MF)
  static-worker/           raw SharedWorker without MFEs (Vite)
  angular-react/           Angular host + React remote (planned)
```

---

## Running the examples

Each example is self-contained. Pick one:

```bash
cd Examples/transport
npm install
npm run dev
```

The `mcp-agent` example needs all three apps running:

```bash
cd Examples/mcp-agent/ollama-agent && npm install && npm run dev  # :3001
cd Examples/mcp-agent/scribe-agent && npm install && npm run dev  # :3002
cd Examples/mcp-agent/host          && npm install && npm run dev  # :3000
```

---

## Developing the library

```bash
cd Library
npm install
npm run build        # one-off build
npm run build:watch  # watch mode
npm test             # jest test suite
npm run test:coverage
```

The library is built with Rollup into 12 entry points (ESM + CJS + `.d.ts` per subpath export). Source is in `Library/src/`.

---

## Examples overview

### `transport/`
The simplest starting point. A single-page vanilla JS app demonstrating all three message patterns: pub/sub, request-reply, and streaming. No framework, no bundler magic.

### `transport-with-persistence/`
Extends the transport example with IndexedDB persistence. Late-joining subscribers can replay the last N messages on subscribe.

### `react-mfe/`
Two independently-deployed React apps (host + remote) that share state through the bus using Module Federation. Shows `useNirnam` and `useNirnamPublish`.

### `agents/`
Three agents in one app — a chat agent, a filesystem agent with File System Access API tools, and a pipeline of two agents where one feeds into the other. Uses the Rsbuild build plugin for Layer 3.

### `cross-tab-agent/`
One "host" tab registers a `scope: 'page'` agent that owns the LLM + tools. Any other tab creates an `AgentProxy` and gets the same chat interface routed over the static SharedWorker. Open two tabs and chat from either.

### `mcp-agent/`
Three Module Federation apps. Two remotes (`ollama-agent`, `scribe-agent`) expose React components that also spin up MCP servers over `NirnamMCPTransport`. The host connects MCP clients to both and orchestrates a document Q&A workflow.

### `static-worker/`
Raw SharedWorker setup without any MFE framework — useful if you want to understand Layer 3 in isolation.
