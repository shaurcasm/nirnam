# Nirnam Transport Layer Analysis
## SharedWorker Identity, Cross-Tab Sharing, and the Path to a True MFE/Multi-Agent Bus

---

## 1. The Blob URL Identity Problem

### How SharedWorker identity works in browsers

A browser identifies a SharedWorker instance by two keys combined:

```
SharedWorker identity = script URL + name
```

Two `new SharedWorker(url, name)` calls sharing the **same URL and same name** connect to the same running worker process. Any mismatch on either key spawns a new, isolated worker.

### Why `URL.createObjectURL` breaks cross-tab sharing

`URL.createObjectURL(blob)` generates a unique UUID-keyed URL on every invocation:

```
Tab A → blob:https://example.com/aaaa-1111-bbbb-2222
Tab B → blob:https://example.com/cccc-3333-dddd-4444
```

The script content inside both blobs is identical. The browser doesn't care — the URLs differ, so each tab gets its own isolated worker. The `name: 'nirnam-message-worker'` option cannot override this; name alone is not sufficient for sharing when URLs differ.

### Current behavior in Nirnam

The current `SharedWorkerInstance` implementation works **only within a single shell page**. When mfe1 and mfe2 are loaded into the same host shell (same tab, same JS execution context), `new SharedWorkerInstance()` is called multiple times within that page. Because JavaScript module evaluation is cached per-page, the `Blob` and `URL.createObjectURL` call happens once, and subsequent calls return the same cached URL — giving the appearance of sharing.

Open the same shell in two different tabs, however, and each tab creates its own Blob URL, its own worker, and there is zero communication between them.

---

## 2. The `type: 'module'` Change

### What "drop the option" means

In `nirnam/src/index.ts`, line 9:

```ts
// Current
const options: WorkerOptions = { type: 'module', name: 'nirnam-message-worker' }

// After dropping
const options: WorkerOptions = { name: 'nirnam-message-worker' }
```

Removing `type: 'module'` switches the SharedWorker from ES module mode to classic script mode.

### Positives

| Positive | Detail |
|----------|--------|
| Firefox compatibility | Firefox historically had buggy or absent support for module-mode SharedWorkers. Classic mode is supported everywhere SharedWorker is supported. |
| Blob URL pairing | Blob URL + classic mode is the established, well-tested path. Blob URL + `type: 'module'` is an edge case that fewer engines have validated. |
| Zero functional change | `worker.js` uses no `import` or `export`. It uses `onconnect`, plain class syntax, and `const` — all valid classic script features. |
| Simpler parsing | Classic mode has simpler parsing rules; less surface area for engine-specific bugs. |

### Negatives

| Negative | Detail |
|----------|--------|
| Locks out ES module syntax in the worker | If the worker script ever needs to split into sub-modules, it cannot use `import`. It must use `importScripts()` (synchronous, blocking, old-style). |
| No top-level `await` | Module mode workers can use top-level `await`; classic workers cannot. Not currently needed, but worth noting for future work. |
| Slightly less modern | Moving away from the direction browser standards are heading, not toward it. |

**Verdict:** The change is low-risk and worth making now. The worker script does not use any module-mode features. If the worker grows in complexity later, it can be reintroduced once Blob URL + module mode has wider stable support, or the worker is served from a static URL where module mode works reliably.

---

## 3. The Fixed Static URL Approach

### How it solves the problem

Serve the worker script at a predictable path from the host application's origin:

```
https://my-shell-app.com/nirnam-worker.js
```

Both tabs now do:

```ts
new SharedWorker('/nirnam-worker.js', 'nirnam-message-worker')
```

Same URL + same name = same worker process. Cross-tab sharing works correctly.

### Why this creates deployment friction for a library

A library that requires a file to be present at a specific public URL breaks the "install and import" contract that npm packages promise.

**Specific issues:**

1. **Consumer must copy the file manually.** The worker script ships inside `node_modules/@shaurcasm/nirnam/dist/`, but it needs to be accessible at `/nirnam-worker.js`. There is no standard npm mechanism that does this automatically.

2. **Build tool integration required.** Frameworks handle `public/` folders differently — Vite copies them, Webpack needs `CopyWebpackPlugin`, Angular needs `assets` config in `angular.json`. The library must document steps for every major build tool.

3. **Version mismatch risk.** If the consumer caches the old `nirnam-worker.js` via a service worker or CDN, and upgrades the npm package, the running worker may be a different version than the library code calling it. The worker's `subscribe`/`broadcast` protocol must remain backward compatible, or the library must detect and handle mismatches.

4. **URL is not configurable by default.** Monorepos with base path configs (`/app/`) may need `/app/nirnam-worker.js`, not `/nirnam-worker.js`. The URL must be configurable.

### Workarounds for the static URL deployment issue

#### Workaround A: Configurable `workerUrl` option (recommended minimum)

```ts
new SharedWorkerInstance({ workerUrl: '/nirnam-worker.js' })
// or
new SharedWorkerInstance({ workerUrl: '/app/nirnam-worker.js' })
```

The library defaults to a conventional path but lets consumers override it. The README documents build-tool-specific steps for copying the file. This is what libraries like `pdf.js` do.

**Trade-off:** Still requires a manual file copy step. But it is explicit and debuggable.

#### Workaround B: Build plugin (better DX)

Ship official plugins for Vite, Webpack, and Rsbuild that automate the copy:

```ts
// vite.config.ts
import { nirnamPlugin } from '@shaurcasm/nirnam/vite'

export default { plugins: [nirnamPlugin()] }
```

The plugin copies `dist/worker.js` to the public folder and injects the correct URL. **Trade-off:** Maintenance burden across multiple bundler ecosystems.

#### Workaround C: Service Worker intercept (zero deployment files)

Register a Service Worker that intercepts requests for a virtual URL and serves the worker script content directly from the library bundle:

```ts
// In nirnam library bootstrap
navigator.serviceWorker.register('/nirnam-sw.js')
// Service worker intercepts GET /nirnam-worker-virtual.js
// and responds with the worker script text
```

The virtual URL is stable, so SharedWorker identity is stable across tabs.

**Trade-off:** Adds a Service Worker dependency (requires HTTPS in production, registration lifecycle, another file to deploy). Swaps one deployment problem for another, though SW registration can potentially be done entirely from library code.

#### Workaround D: `import.meta.url`-relative URL (ESM bundles only)

When the library is loaded as an ES module from a URL (not bundled inline), `import.meta.url` gives the library's own URL. The worker can be referenced relative to it:

```ts
const workerUrl = new URL('./worker.js', import.meta.url).href;
new SharedWorker(workerUrl, 'nirnam-message-worker')
```

If the library is served from `https://cdn.example.com/@shaurcasm/nirnam@1.0.0/dist/index.esm.js`, the worker resolves to `https://cdn.example.com/@shaurcasm/nirnam@1.0.0/dist/worker.js` — a stable, versioned URL. **This is the cleanest solution for CDN-hosted usage.**

**Trade-off:** Breaks when the library is bundled inline by Webpack/Rollup (the `import.meta.url` resolves to the bundle's own URL, not a worker file). Works correctly for the UMD/CDN path and for consumers using `external` in their bundler config.

---

## 4. Alternatives to SharedWorker for Cross-Tab Transport

If a fixed static URL is unacceptable and Blob URL identity is unsolvable for cross-tab scenarios, these alternatives offer different trade-offs.

### 4.1 BroadcastChannel API

```ts
const channel = new BroadcastChannel('nirnam-bus')
channel.postMessage({ topic: 'counter', message: 42 })
channel.onmessage = (event) => { /* ... */ }
```

**How it solves the identity problem:** `BroadcastChannel` is keyed by name only. Any same-origin context (tab, iframe, worker) that opens a channel with the same name participates in the same channel automatically — no URL, no blob, no deployment.

| Aspect | Detail |
|--------|--------|
| Cross-tab sharing | Native — same name = same channel |
| Cross-framework | Yes — framework-agnostic API |
| Subscriber registry | No — no central state; every subscriber must be actively listening |
| Message buffering | No — messages sent when no one listens are lost |
| Request-reply | Manual — must implement correlation IDs yourself |
| Browser support | Excellent (all modern browsers) |
| Deployment requirement | None |

**Where it falls short for Nirnam's goals:** BroadcastChannel has no persistent subscriber list. The current Nirnam worker maintains `topic_subscribers` — a map of topics to active ports. If mfe2's button subscribes to `counter` but mfe1 broadcasts before the subscription is set up, the message is lost. BroadcastChannel has the same race condition with no mitigation built in.

**Verdict:** Simpler than SharedWorker and solves cross-tab sharing immediately. Suitable as the cross-tab transport layer in a hybrid architecture. Not a full replacement because it lacks centralized state.

### 4.2 IndexedDB as Message Store

IndexedDB is a same-origin, persistent, structured storage database available in all browser contexts including workers. It can serve as a shared state store that all tabs can read from and write to.

**Pattern:** Producer writes message to an `events` object store. Consumer polls or uses a notification trigger to read new entries.

```
mfe1 (Tab A) → writes { topic, message, timestamp, id } → IndexedDB
mfe2 (Tab B) → reads from IndexedDB on trigger → processes event
```

**The notification problem:** IndexedDB has no native pub/sub. Writes do not wake up other tabs. A pure IndexedDB approach requires polling, which introduces latency and battery/CPU overhead.

**Hybrid: IndexedDB + BroadcastChannel**

```
Producer → writes to IndexedDB → BroadcastChannel.postMessage('new-event', { id })
Consumer → hears BroadcastChannel → reads from IndexedDB by id → processes
```

This combines BroadcastChannel's real-time notification with IndexedDB's persistence. Late-joining subscribers can replay missed messages from IndexedDB.

| Aspect | Detail |
|--------|--------|
| Cross-tab sharing | Yes |
| Message persistence / replay | Yes — this is the unique advantage |
| Complexity | High — two APIs to orchestrate |
| Latency | One extra async read per message |
| Request-reply | Possible — store requests and responses by correlation ID |

**Where this fits for Nirnam:** IndexedDB makes sense specifically if message history and late-subscriber replay are features you want. For a multi-agent LLM transport layer, replaying the last N tool calls to a newly joined agent is a legitimately useful feature. For simple fire-and-forget MFE events, the complexity is not worth it.

### 4.3 Service Worker as Relay

A Service Worker runs in a background context shared across all tabs of an origin. It can receive messages from any tab via `navigator.serviceWorker.controller.postMessage()` and fan out to all tabs using `clients.matchAll()`.

```
Tab A → SW.postMessage({ topic, message })
SW     → clients.matchAll() → Tab A, Tab B, Tab C...
SW     → client.postMessage({ topic, message }) → each tab
```

| Aspect | Detail |
|--------|--------|
| Cross-tab sharing | Yes |
| Persistent subscriber registry | Yes — SW can maintain state |
| Requires HTTPS | Yes (except localhost) |
| Offline support | Bonus — messages can be queued if a tab is in the background |
| Deployment | Must deploy the SW script; same URL problem as SharedWorker |
| Complexity | High — SW lifecycle (install, activate, update) is non-trivial |

**Verdict:** Powerful but introduces significant lifecycle complexity. The SW script has the same static URL deployment problem as the SharedWorker script, so it doesn't cleanly solve the library packaging issue.

---

## 5. Recommended Architecture for Nirnam

Given the goals — **packaged library, zero-config where possible, true cross-tab MFE/multi-agent transport** — the best path is a **layered hybrid**:

### Layer 1: BroadcastChannel (cross-tab, always-on)

Use BroadcastChannel as the cross-tab backbone. It requires no deployment, no URL, no service worker. All tabs on the same origin participate by opening a channel with the library's fixed name.

### Layer 2: SharedWorker within a page (same-tab, low-latency)

Keep the existing Blob URL SharedWorker for within-page MFE communication (mfe1 and mfe2 loaded in the same shell). The worker maintains the subscriber registry and handles message routing between micro-frontends in the same tab. Messages that cross tab boundaries are forwarded to the BroadcastChannel.

### Layer 3: Opt-in static URL (cross-tab SharedWorker, when deployable)

For teams that can serve a static file, provide the `workerUrl` option. This replaces both layers above with a single true SharedWorker that spans tabs. The library docs make the trade-off clear.

### Message flow (hybrid)

```
mfe1 (Tab A)                    SharedWorker (Tab A)       BroadcastChannel
   │                                    │                         │
   │── broadcast(topic, msg) ──────────▶│                         │
   │                                    │── postMessage ─────────▶│
   │                                    │                         │── all tabs
   │                                    │                   Tab B listeners
```

### What this means for the MCP/multi-agent use case

For LLM agents as MFE remotes communicating via Nirnam as a transport layer:

- **Request-reply correlation** becomes mandatory. Add `requestId` to every message and route responses back to the originating port/tab. The `NARROW` type in `DataEvent` is already this concept — it needs to be connected to the main library.
- **Agent registry** — agents announce themselves on connect; the worker/channel maintains a registry of active agents and their capabilities. The orchestrator queries this to discover available tools.
- **BroadcastChannel** is sufficient for agent-to-agent messaging across tabs (each message is small JSON, latency is negligible). SharedWorker adds value only for the subscriber registry and within-page routing.

---

## 6. Summary Table

| Transport | Cross-tab | Deploy required | Subscriber registry | Request-reply | Complexity |
|-----------|-----------|-----------------|--------------------|--------------|-----------:|
| Blob URL SharedWorker (current) | ✗ | No | Yes | No | Low |
| Static URL SharedWorker | ✓ | Yes (file copy) | Yes | No | Low |
| BroadcastChannel | ✓ | No | No | Manual | Low |
| IndexedDB + BroadcastChannel | ✓ | No | Persistent | Yes | High |
| Service Worker relay | ✓ | Yes (SW script) | Yes | Yes | High |
| **Hybrid (BC + Blob SW)** | **✓** | **No** | **Yes (within-tab)** | **Manual** | **Medium** |
| **Static URL + plugin** | **✓** | **Plugin automates** | **Yes** | **Manual** | **Medium** |
