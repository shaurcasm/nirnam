# Nirnam Agent API Design

> Design spec for `@palinc/nirnam/agents` — a browser-native MCP agent layer built on the Nirnam bus.

---

## Where this sits

```
@palinc/nirnam/agents          ← this document
    │
    ├── @palinc/nirnam/mcp     ← NirnamMCPTransport (existing roadmap)
    │       └── @modelcontextprotocol/sdk
    │
    └── @palinc/nirnam         ← bus core: publish/subscribe/request/handle
            └── SharedWorker (NirnamBus)
```

Each agent runs in its own dedicated `Worker`. It connects to the shared Nirnam bus, registers its capabilities, and either waits for messages (passive) or exposes a chat interface driven by an LLM (active). The library owns the agentic loop with interceptor hooks as escape hatches.

---

## Package shape

```ts
// Main agent factory — only import this subpath
import { createAgent, connectAgents } from '@palinc/nirnam/agents';

// Optional: filesystem helpers
import { requestFolderAccess } from '@palinc/nirnam/agents/fs';

// Optional: React bindings (peer: react >= 17)
import { useAgent, useAgentChat } from '@palinc/nirnam/agents/react';
```

**Peer dependencies added by `/agents`:**
- `@modelcontextprotocol/sdk` — MCP client/server protocol
- No LLM SDK dependency — the library calls LLM APIs directly over `fetch` (browser-native, no Node.js adapters)

---

## Core API

### `createAgent(config)`

```ts
import { createAgent } from '@palinc/nirnam/agents';

const agent = createAgent({
  // --- Identity ---
  agentId: 'support-agent',        // optional; auto-generated (uuid) if omitted

  // --- LLM connection ---
  llm: {
    url: 'http://localhost:11434/v1',  // any OpenAI-compatible endpoint
    model: 'llama3.2',
    apiKey: 'sk-...',                  // omit for local models (Ollama, LM Studio)
    // provider defaults to 'openai-compat'
    // set to 'anthropic' for Claude API (different request shape)
  },

  // --- Agent mode ---
  mode: 'active',                   // 'active' (default) | 'passive'
  systemPrompt: 'You are a helpful support assistant.',

  // --- Bus ---
  // If omitted, agent creates its own bus internally.
  // Pass your app's existing bus so the agent shares the same SharedWorker.
  bus,

  // --- Initial tools (beyond filesystem) ---
  tools: [myCustomTool],
});
```

`createAgent()` returns synchronously. The agent worker is spawned immediately and begins registering on the bus. Readiness is signalled via `agent.ready` (a `Promise<void>`).

```ts
await agent.ready;
// agent is now registered; bus.discoverAgents() will include it
```

---

## Filesystem Access

The browser's File System Access API gives the LLM read/write access to a user-chosen folder. The user must explicitly grant access — the browser shows a native picker. Nothing is accessible without that grant.

```ts
// Prompt the user to choose a folder and grant read/write access
const handle = await agent.requestFolderAccess({ mode: 'readwrite' });
```

Once granted, the agent automatically gains these MCP tools (available to its LLM):

| Tool | Description |
|---|---|
| `read_file` | Read a file relative to the granted root |
| `write_file` | Write/overwrite a file |
| `list_directory` | List files and subdirectories |
| `create_directory` | Create a new directory |
| `delete_file` | Delete a file (prompts interceptor first if registered) |
| `move_file` | Rename or move a file within the root |

The folder handle is scoped to the agent. Other agents do not inherit access unless you explicitly share the handle:

```ts
// Share the same folder handle with a second agent
const handle = await agentA.requestFolderAccess({ mode: 'readwrite' });
await agentB.mountFolder(handle);
```

### Requesting folder access for a specific operation

You can also defer the request until the LLM actually needs it (lazy):

```ts
createAgent({
  filesystem: {
    mode: 'readwrite',
    lazy: true,         // browser picker shown only when LLM first calls a file tool
  },
  ...
})
```

### Revoking access

```ts
agent.revokeFolder();   // drops the handle; file tools are removed from the LLM's toolset
```

---

## Active Agents — Chat Interface

Active agents have an LLM that can reason, call tools, and hold a conversation.

### `agent.chat(message)`

```ts
// Single round-trip — library runs the full loop internally
const reply = await agent.chat('Summarise the README.md in the project folder');
// → "The README describes a pub/sub library for micro-frontends..."
```

The loop the library runs:

```
user message
    │
    ▼
LLM call (with system prompt + history + tool definitions)
    │
    ├── if LLM returns text only → return text to caller
    │
    └── if LLM returns tool calls
            │
            ▼
        execute tools (in parallel if independent)
            │
            ▼
        feed results back to LLM
            │
            ▼
        repeat until LLM returns final text
```

### `agent.chatStream(message)`

```ts
for await (const chunk of agent.chatStream('Explain the bus architecture')) {
  process.stdout.write(chunk);   // or update React state per token
}
```

Streaming propagates through the tool loop too — final text chunks stream, tool execution is awaited silently between streams.

### Message history

```ts
agent.history;              // Message[] — full conversation so far
agent.clearHistory();       // resets to system prompt only
agent.exportHistory();      // returns a serialisable snapshot
agent.importHistory(snap);  // restore a previous session
```

### `agent.run(task)` — headless task execution

For non-interactive use (passive task dispatch to an active agent):

```ts
const result = await agent.run('Scan the src/ directory and list all TODO comments');
// Runs the full loop, returns final text. No persistent history entry.
```

---

## Interceptors — Escape Hatches

Interceptors give you control over each step of the loop without reimplementing the loop.

### Before a tool call (approval gate)

```ts
const unsubscribe = agent.onBeforeToolCall(async (call, next) => {
  if (call.name === 'delete_file') {
    const confirmed = await showConfirmDialog(`Delete ${call.args.path}?`);
    if (!confirmed) {
      // Return a synthetic error result — the LLM sees "user denied" and adapts
      return { error: 'User denied the delete operation.' };
    }
  }
  return next(call);   // proceed normally
});

// Remove the interceptor later
unsubscribe();
```

### After a tool result (logging, mutation)

```ts
agent.onAfterToolCall((call, result) => {
  telemetry.track('tool_executed', { tool: call.name, agentId: agent.agentId });
  return result;   // or return a modified result
});
```

### On every LLM message (observability)

```ts
agent.onMessage((message) => {
  console.log('[agent]', message.role, message.content?.slice(0, 80));
});
```

### Before LLM call (prompt injection, context enrichment)

```ts
agent.onBeforeLLMCall((messages, next) => {
  // Inject dynamic context just before each LLM call
  const enriched = [...messages, {
    role: 'system',
    content: `Current time: ${new Date().toISOString()}`,
  }];
  return next(enriched);
});
```

---

## Passive Agents

Passive agents run in the background with a fixed system prompt. They do not have a `chat()` interface. They respond to bus messages and can call their LLM internally to process each one.

```ts
const monitor = createAgent({
  agentId: 'log-monitor',
  mode: 'passive',
  systemPrompt: `You monitor application error logs.
When you receive a log entry, identify the severity and suggest a fix.
Respond in JSON: { severity, message, suggestion }.`,
  llm: { url: 'http://localhost:11434/v1', model: 'mistral' },
  bus,
});

await monitor.ready;

// Register what this agent responds to
monitor.handle('error-log', async (logEntry) => {
  const analysis = await monitor.process(logEntry);   // runs LLM internally
  return analysis;   // returned as the bus response to the requester
});
```

The `monitor.process(input)` method is the passive equivalent of `agent.chat()`. It prepends the system prompt, runs the loop once (no persistent history by default), and returns the result.

```ts
// Optional: give passive agents memory across calls
const monitor = createAgent({
  mode: 'passive',
  retainHistory: true,    // accumulates context across process() calls
  maxHistoryTokens: 4000, // auto-truncates oldest messages when limit approached
  ...
});
```

---

## Agent-to-Agent Communication

Agent communication uses the Nirnam bus directly — explicit, developer-wired. No automatic LLM routing.

### Sending a request and waiting for a response

```ts
// agentA asks agentB to summarise some text
const summary = await agentA.request('summarizer-agent', 'summarize', {
  text: longDocument,
});
```

Under the hood this is `bus.request()` routed by `agentId + topic`. The target agent must have registered a handler for that topic.

### Registering handlers (what an agent can receive)

```ts
// agentB exposes a 'summarize' capability
agentB.handle('summarize', async ({ text }) => {
  const result = await agentB.run(`Summarise the following:\n\n${text}`);
  return { summary: result };
});
```

### Fire-and-forget publish

```ts
// agentA broadcasts a result to whoever is listening
agentA.publish('analysis-complete', { documentId, findings });

// Any other agent can subscribe
agentC.subscribe('analysis-complete', (event) => {
  console.log('Received findings:', event.findings);
});
```

### `connectAgents(agents, topology)` — pipeline wiring

A helper for common multi-agent patterns:

```ts
import { connectAgents } from '@palinc/nirnam/agents';

// Linear pipeline: each agent's output feeds the next
connectAgents([ingester, summarizer, reviewer], { topology: 'pipeline', topic: 'document' });

// Fan-out: ingester publishes to all agents in parallel
connectAgents([ingester, [summarizer, classifier, tagger]], { topology: 'fan-out', topic: 'document' });
```

### Exposing an agent as a tool for another agent's LLM

If you want agent A's LLM to be able to call agent B as a tool (LLM-driven routing for that specific relationship), you can register B as a tool on A explicitly:

```ts
agentA.addTool(agentB.asTool({
  name: 'ask_summarizer',
  description: 'Ask the summarizer agent to condense a long document.',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
}));
```

`asTool()` returns a standard MCP tool definition that wraps `agentA.request(agentB.agentId, ...)` internally. This is opt-in per-relationship, not automatic.

---

## Lifecycle & Cleanup

### Stopping and resuming

```ts
agent.stop();    // pauses: stops accepting new messages, in-flight requests complete
agent.resume();  // restarts acceptance
```

### Full destruction

```ts
agent.destroy();
// 1. Stops the agent
// 2. Calls bus.deregister(agentId) — fires 'leave' event to all listeners
// 3. Terminates the Worker
// 4. Revokes any filesystem handle
// 5. Cancels all pending requests with NirnamRequestError('AGENT_DESTROYED')
```

### Bus-level cleanup

```ts
// Destroy all agents connected to a bus at once (e.g. on page unload)
bus.destroyAllAgents();

// Or register a cleanup on page unload automatically
createAgent({ ..., autoCleanup: true });  // default: true
```

`autoCleanup: true` registers a `beforeunload` listener that calls `agent.destroy()` so the SharedWorker's registry doesn't hold stale entries after the tab closes.

### Aborting in-flight operations

```ts
const controller = new AbortController();
const reply = await agent.chat('Do a long task...', { signal: controller.signal });

// Cancel mid-flight
controller.abort();
// → agent.chat() rejects with AbortError; in-flight LLM call is cancelled
```

---

## Status and Observability

```ts
agent.status;
// 'initializing' | 'ready' | 'busy' | 'stopped' | 'destroyed'

agent.stats;
// { messagesProcessed, toolCallsExecuted, tokensUsed, uptime }

// Subscribe to status changes
agent.onStatusChange((status) => {
  console.log(agent.agentId, 'is now', status);
});
```

---

## Suggested Developer Experience Features

### 1. Agent presets

Built-in agent configurations for common patterns, so a developer can skip boilerplate:

```ts
import { presets } from '@palinc/nirnam/agents';

// Filesystem agent — preconfigured with all file tools + a sensible system prompt
const fsAgent = createAgent({
  ...presets.filesystem({ mode: 'readwrite' }),
  llm: { url: 'http://localhost:11434/v1', model: 'llama3.2' },
});

// Available presets: presets.filesystem, presets.codeReview, presets.summarizer, presets.monitor
```

### 2. Mock LLM for testing

```ts
import { mockLLM } from '@palinc/nirnam/agents/testing';

const agent = createAgent({
  llm: mockLLM({
    // Static response
    response: 'This is a test summary.',

    // Or: deterministic tool-calling mock
    toolCalls: [
      { name: 'read_file', args: { path: 'README.md' } },
    ],
    afterToolCalls: 'Here is the file content.',
  }),
  ...
});
```

This lets you unit-test your agent wiring, interceptors, and bus message handling without a running LLM server.

### 3. React hooks (`@palinc/nirnam/agents/react`)

```tsx
import { useAgent, useAgentChat, useAgentStatus } from '@palinc/nirnam/agents/react';

function SupportWidget() {
  const agent = useAgent(agentConfig);   // creates + destroys with component lifecycle
  const { messages, send, isStreaming } = useAgentChat(agent);
  const status = useAgentStatus(agent);

  return (
    <div>
      <span>{status}</span>
      {messages.map(m => <div key={m.id}>{m.content}</div>)}
      <button onClick={() => send('Hello')} disabled={isStreaming}>Send</button>
    </div>
  );
}
```

`useAgent()` handles `createAgent()` on mount and `agent.destroy()` on unmount. Ref-stable across re-renders.

### 4. Agent devtools panel

A separate `@palinc/nirnam/devtools` package (dev-only, tree-shaken in production) that renders a floating panel showing:

- All registered agents and their current status
- Live bus message traffic (topic, sender, receiver, latency)
- Per-agent tool call history with inputs and outputs
- Token usage over time
- A "send message" input to any agent for manual testing

Activated by:
```ts
import { installDevtools } from '@palinc/nirnam/devtools';
if (process.env.NODE_ENV === 'development') {
  installDevtools({ bus });
}
```

### 5. Typed message schemas

Optional Zod integration for validating bus message payloads at runtime:

```ts
import { z } from 'zod';

agentB.handle('summarize', {
  input: z.object({ text: z.string().min(1) }),
  output: z.object({ summary: z.string() }),
  handler: async ({ text }) => {
    const summary = await agentB.run(`Summarise: ${text}`);
    return { summary };
  },
});
```

Runtime validation runs before the handler. Type inference flows through automatically — the input and output are typed from the schema.

### 6. Structured logging

```ts
createAgent({
  logger: {
    level: 'debug',                    // 'silent' | 'error' | 'warn' | 'info' | 'debug'
    transport: (entry) => myLogger(entry),   // plug into your existing logger
  },
  ...
});
```

Default logger writes to `console` in development, silent in production (detected via `process.env.NODE_ENV`).

### 7. Agent health heartbeat

```ts
createAgent({
  heartbeat: {
    interval: 10_000,       // ping the bus every 10s to signal liveness
    timeout: 30_000,        // if no ping for 30s, bus marks agent as 'stale' and fires 'leave'
  },
  ...
});
```

Prevents stale entries in the agent registry when a Worker crashes silently (no `close` event on the port).

---

## Full Example — Local Ollama + Filesystem

```ts
import { createBus } from '@palinc/nirnam';
import { createAgent, connectAgents } from '@palinc/nirnam/agents';

const bus = createBus({ workerUrl: '/nirnam-worker.js' });

// Create an active agent connected to local Ollama
const assistant = createAgent({
  agentId: 'assistant',
  mode: 'active',
  systemPrompt: 'You are a code assistant with access to the user\'s project files.',
  llm: {
    url: 'http://localhost:11434/v1',
    model: 'codellama',
  },
  bus,
  autoCleanup: true,
});

// Grant folder access (shows native browser picker)
const folder = await assistant.requestFolderAccess({ mode: 'readwrite' });

// Intercept destructive operations
assistant.onBeforeToolCall(async (call, next) => {
  if (call.name === 'delete_file' || call.name === 'write_file') {
    const ok = confirm(`Allow agent to ${call.name}: ${call.args.path}?`);
    if (!ok) return { error: 'User denied.' };
  }
  return next(call);
});

await assistant.ready;

// Chat
const reply = await assistant.chat('List all TypeScript files and find any with TODO comments');
console.log(reply);

// --- Add a passive background monitor ---
const monitor = createAgent({
  agentId: 'error-monitor',
  mode: 'passive',
  systemPrompt: 'Classify error logs. Return JSON: { level, category, suggestion }.',
  llm: { url: 'http://localhost:11434/v1', model: 'llama3.2' },
  bus,
  autoCleanup: true,
});

monitor.handle('error-log', async (log) => {
  return monitor.process(JSON.stringify(log));
});

// --- Wire agents together ---
// Assistant can delegate error analysis to the monitor
assistant.addTool(monitor.asTool({
  name: 'analyse_error',
  description: 'Analyse an error log entry and get a classification and suggestion.',
  inputSchema: { type: 'object', properties: { log: { type: 'string' } } },
}));

// The assistant's LLM can now call 'analyse_error' and get monitor's response
const analysis = await assistant.chat('Analyse this error: TypeError: Cannot read property of undefined at App.tsx:42');

// --- Cleanup (also happens automatically on page unload via autoCleanup) ---
await assistant.destroy();
await monitor.destroy();
```

---

## What the library does NOT do

| Concern | Owner |
|---|---|
| Provisioning LLM servers | Developer / user (Ollama, LM Studio, Claude API) |
| Authentication to LLM APIs | Developer (pass `apiKey` in config) |
| Persistent storage of conversations | Developer (use `agent.exportHistory()` + your storage layer) |
| Cross-origin agent communication | Requires Layer 3 static SharedWorker or WebSocket relay |
| Rate limiting / cost management | Developer (use `onBeforeLLMCall` interceptor to gate calls) |

---

## Open Questions Before Implementation

1. **Streaming tool results to the LLM** — does the target LLM support streaming with interleaved tool calls? (Ollama does; some providers don't.) The library should detect this via a capability probe on startup.

2. **Worker bundling** — each agent Worker needs access to the LLM client code and MCP SDK. Options: (a) bundle everything into the agent worker blob (large blob, simple); (b) use `importScripts()` from a CDN (network dependency); (c) use Module Federation to load agent code from a remote (connects back to Part 1 of the dynamic remotes doc). Decision affects the `spawnAgentWorker` implementation significantly.

3. **Ollama vs OpenAI tool call format** — Ollama's tool call JSON differs slightly from OpenAI's in some versions. The library will need a normalisation layer.

4. **Cross-tab passive agents** — if a passive monitor agent should survive tab refresh and be shared across tabs, it needs the Layer 3 static SharedWorker (not the Blob URL worker). This should be a config option: `scope: 'tab' | 'page'` (page = persists across same-origin tabs).
