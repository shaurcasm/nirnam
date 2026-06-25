# @palinc/nirnam/agents — Agent API Context

> Authoritative reference for the Nirnam agentic layer: NirnamAgent, LLM integration,
> tool use, filesystem, bus communication, interceptors, multi-agent topologies, presets,
> cross-tab agents (scope: 'page'), AgentProxy, IndexedDB history persistence,
> and React hooks. Generated from source — keep in sync with `Library/src/agents/`.

---

## What is a NirnamAgent?

A `NirnamAgent` is a **browser-native LLM agent** that runs in the main thread.
It owns an agentic loop (LLM → parse → tool calls → repeat) and communicates with
other agents or MFEs through the Nirnam SharedWorker bus.

**Key properties:**
- Agents live in the **main thread** of the tab that created them.
- `scope: 'tab'` (default) — private to the tab. Does not survive page refresh.
- `scope: 'page'` — registers bus handlers so any tab can call it via `AgentProxy`. History is persisted to IndexedDB and restored on page reload.
- `autoCleanup: true` (default) hooks `beforeunload` to call `destroy()` automatically.

---

## Import paths

```ts
import { createAgent, NirnamAgent,
         AgentProxy, createAgentProxy,
         connectAgents, pipelinePublish, fanOutPublish,
         presets, withPreset } from '@palinc/nirnam/agents';

import type { AgentConfig, AgentStatus, AgentStats,
              AgentProxyOptions, PageChatRequest, PageRunRequest,
              LLMConfig, RealLLMConfig, MockLLMConfig, LLMProvider,
              ToolDefinition, ToolCall, ToolResult,
              Message, InternalMessage,
              ToolCallInterceptor, ToolResultInterceptor, BeforeLLMCallInterceptor,
              MessageHandler, StatusChangeHandler,
              ChatOptions, ConnectOptions, AgentTopology,
              FilesystemOptions, LoggerConfig, LogEntry } from '@palinc/nirnam/agents';

// React hooks
import { useAgent, useAgentChat, useAgentStatus } from '@palinc/nirnam/agents/react';
import type { AgentChatState } from '@palinc/nirnam/agents/react';

// Testing utilities
import { mockLLM, scenarioMock, isMockLLM } from '@palinc/nirnam/agents/testing';
```

---

## `createAgent(config)` → `NirnamAgent`

Synchronous factory. Returns a `NirnamAgent` ready to use. Async initialization
(bus registration) completes in the background and is tracked by `agent.ready`.

```ts
const agent = createAgent({
  llm: { url: 'http://localhost:11434/v1', model: 'llama3.2' },
  systemPrompt: 'You are a helpful assistant.',
  tools: [myTool],
  autoCleanup: true,  // default
});
await agent.ready;
```

---

## `AgentConfig`

```ts
interface AgentConfig {
  agentId?: string;               // Auto-generated if omitted (stable for the session)
  llm: LLMConfig;                 // Required. Real LLM or mock.
  mode?: 'active' | 'passive';    // Default: 'active'
  scope?: 'tab' | 'page';         // Default: 'tab'. See "Cross-tab agents" below.
  systemPrompt?: string;
  bus?: NirnamBus;                // Use an external bus. Omit to create a private one.
  tools?: ToolDefinition[];       // Initial tool set. More can be added later.
  filesystem?: FilesystemOptions; // Enable filesystem tools.
  autoCleanup?: boolean;          // Default: true — destroys agent on page unload.
  logger?: LoggerConfig;          // Default: silent.
  retainHistory?: boolean;        // Default: false — run() restores history after each call.
}
```

### `scope: 'tab'` vs `scope: 'page'`

| | `'tab'` (default) | `'page'` |
|---|---|---|
| Cross-tab access | No | Yes — via `AgentProxy` |
| Survives page refresh | No | Yes — history in IndexedDB |
| Bus layer required | Layer 2+ | Layer 3 (static URL SharedWorker) |
| Bus handlers registered | No | `${agentId}:__chat`, `__run`, `__stream` |
| Registration metadata | `{ mode }` | `{ mode, scope: 'page' }` |

> **Layer 3 requirement for cross-tab:** `scope: 'page'` registers request handlers on the bus. Request routing across browser tabs requires the Layer 3 static SharedWorker (enabled by `@palinc/nirnam/vite`, `/rsbuild`, or `/webpack` plugins). Without Layer 3 the proxy calls fail with `NirnamRequestError(NO_HANDLER)` when the proxy is in a different tab.

### `mode: 'active'` vs `mode: 'passive'`

| | `active` (default) | `passive` |
|---|---|---|
| Public history | Yes (`agent.history`) | No (empty) |
| Use `chat()` | Yes | No (warn) |
| Use `run()` | Yes | Yes |
| Use `process()` | Warns, still works | Intended use |

### `bus?: NirnamBus`

If omitted, the agent creates and owns its own internal bus (closed on `destroy()`).
Pass an external bus to share the bus with other agents or the MFE — the agent will NOT close it on destroy.

```ts
// Two agents on the same bus (required for connectAgents to work)
const sharedBus = createBus();
const a = createAgent({ llm, bus: sharedBus, ... });
const b = createAgent({ llm, bus: sharedBus, ... });
```

### `retainHistory?: boolean`

Controls `run()` and `process()` history persistence.
- `false` (default): `run()` saves and restores history — each call is isolated.
- `true`: `run()` and `process()` accumulate context across calls.

---

## LLM Configuration

### Real LLM

```ts
interface RealLLMConfig {
  url: string;       // Base URL of the LLM endpoint
  model: string;
  apiKey?: string;
  provider?: LLMProvider;  // 'openai-compat' | 'anthropic'. Auto-detected if omitted.
}
```

**Provider auto-detection:** If `url` contains `anthropic.com`, provider is `'anthropic'`. Otherwise `'openai-compat'`.

**OpenAI-compat** (Ollama, LM Studio, OpenAI, any OpenAI-compatible endpoint):
```ts
{ url: 'http://localhost:11434/v1', model: 'llama3.2' }
{ url: 'https://api.openai.com/v1', model: 'gpt-4o', apiKey: 'sk-...' }
{ url: 'http://localhost:1234/v1', model: 'mistral-7b' }  // LM Studio
```

**Anthropic:**
```ts
{ url: 'https://api.anthropic.com', model: 'claude-sonnet-4-6', apiKey: 'sk-ant-...' }
// Sends to POST /v1/messages with x-api-key + anthropic-version headers
// Converts system messages to system parameter
// Batches consecutive tool results into a single user message
```

### Mock LLM (for tests and offline demos)

```ts
// From @palinc/nirnam/agents/testing
import { mockLLM } from '@palinc/nirnam/agents/testing';

// Static response
const llm = mockLLM({ response: 'Hello!' });

// Scripted tool call followed by a response
const llm = mockLLM({
  toolCalls: [{ name: 'search', args: { query: 'cats' } }],
  afterToolCalls: 'Found 3 results.',
});

// Custom handler
const llm = mockLLM({
  handler: (messages) => ({
    content: `Echo: ${messages.at(-1)?.content}`,
    toolCalls: [],
    finishReason: 'stop',
  }),
});
```

---

## Agent status lifecycle

```
initializing → ready ⇌ busy → stopped ⇌ ready
                                         ↓
                                      destroyed
```

```ts
type AgentStatus = 'initializing' | 'ready' | 'busy' | 'stopped' | 'destroyed';

agent.status          // current status (synchronous read)
agent.onStatusChange(handler)  // subscribe to transitions
```

- `initializing` → transitions to `ready` after the bus registration completes (and history restore, for `scope: 'page'`).
- `busy` → set while `chat()`, `chatStream()`, `run()`, or `process()` is in progress.
- `stopped` → set by `stop()`. Calling chat/run/process throws. Resume with `resume()`.
- `destroyed` → set by `destroy()`. All bus subscriptions removed. Cannot be resumed.

---

## Core conversation methods

### `agent.chat(message, options?)` → `Promise<string>`

Full agentic loop. Runs LLM → parses tool calls → executes tools → feeds results → repeats until no tool calls or `maxIterations` reached. Updates public `history`. For `scope: 'page'` agents, persists history to IndexedDB after completion.

```ts
const reply = await agent.chat('What is 3 * 7?');
console.log(reply); // "The answer is 21."

// With abort signal and iteration cap
const ctrl = new AbortController();
const reply = await agent.chat('Analyse this dataset', {
  signal: ctrl.signal,
  maxIterations: 5,
});
```

- Default `maxIterations`: 10.
- If `signal` is already aborted before the call, rejects immediately.
- Throws `Error` if agent is `stopped` or `destroyed`.

### `agent.chatStream(message, options?)` → `AsyncGenerator<string>`

Same as `chat()` but streams the **final** LLM response token-by-token. Tool calls before the final response are resolved non-streaming. For `scope: 'page'` agents, persists history after the stream ends.

```ts
for await (const chunk of agent.chatStream('Tell me a story about MFEs')) {
  process.stdout.write(chunk);
}
```

### `agent.run(task, options?)` → `Promise<string>`

One-shot task execution. Runs the agentic loop (LLM + tools), returns the final string, then **restores history** to pre-call state (unless `retainHistory: true`). For `scope: 'page'` agents with `retainHistory: true`, persists history after completion.

```ts
const summary = await agent.run('Summarize: The quick brown fox...');
// agent.history is unchanged after this call
```

### `agent.process(input)` → `Promise<string>`

Passive-mode processing without maintaining public history. Intended for `mode: 'passive'` agents; calling it on an active agent logs a warning.

```ts
// Passive monitor agent
const result = await agent.process('[ERROR] Database connection refused');
// Returns JSON classification, does not update agent.history
```

### Method comparison

| Method | Updates `history` | Restores history after | Tool loop | Streaming | IDB persist (`scope:'page'`) |
|--------|------------------|-----------------------|-----------|-----------|-------------------------------|
| `chat()` | Yes | — (persists) | Yes | No | Yes |
| `chatStream()` | Yes | — (persists) | Yes (non-stream) | Yes (final) | Yes |
| `run()` | During call only* | Yes (default) | Yes | No | Only if `retainHistory: true` |
| `process()` | No (passive) | — | No | No | No |

*`run()` restores history after completing unless `retainHistory: true`.

---

## Cross-tab agents — `scope: 'page'` and `AgentProxy`

### Architecture

The agent's LLM client, tool executor, and File System Access API always run in the **host tab's main thread**. The Layer 3 SharedWorker acts as a message router only — no agent logic runs inside the worker.

```
┌──────────────── Tab A (host) ───────────────────┐
│  NirnamAgent(scope:'page', agentId:'my-agent')  │
│  ├─ Registers bus.handle('my-agent:__chat', …)  │
│  ├─ Registers bus.handle('my-agent:__run', …)   │
│  └─ Registers bus.handleStream('…:__stream', …) │
└─────────────────────────────────────────────────┘
                    │  Layer 3 SharedWorker (routes) │
┌──────────────── Tab B (client) ─────────────────┐
│  AgentProxy('my-agent', bus)                    │
│  └─ proxy.chat(msg) → bus.request('…:__chat')   │
└─────────────────────────────────────────────────┘
```

### Host tab setup

```ts
import { createAgent } from '@palinc/nirnam/agents';
import { createBus } from '@palinc/nirnam';

const bus = createBus(); // Layer 3 bus (nirnamPlugin() must be active in build config)

const agent = createAgent({
  agentId: 'my-agent',      // stable ID — required for cross-tab discovery + IDB persistence
  scope: 'page',
  llm: { url: '...', model: 'gpt-4o', apiKey: '...' },
  bus,
  autoCleanup: true,        // default — deregisters handlers on beforeunload
});
await agent.ready;
```

On `ready`:
1. Saved history from the previous session is restored from IndexedDB (if any).
2. Bus handlers for `__chat`, `__run`, `__stream` are registered.
3. Registration metadata includes `{ scope: 'page' }`.

### Client tab proxy

```ts
import { createAgentProxy } from '@palinc/nirnam/agents';
import { createBus } from '@palinc/nirnam';

const bus = createBus(); // same origin, same Layer 3 worker URL
const proxy = createAgentProxy('my-agent', bus, { timeout: 30_000 });

// Call just like a local agent
const reply = await proxy.chat('Hello!');
const result = await proxy.run('Summarize this document');

// Streaming
for await (const chunk of proxy.chatStream('Tell me a story')) {
  process.stdout.write(chunk);
}
```

### `AgentProxy` API

```ts
class AgentProxy {
  readonly agentId: string;

  chat(message: string, options?: {
    maxIterations?: number;
    timeout?: number;    // per-call timeout; overrides constructor default
  }): Promise<string>;

  run(task: string, options?: {
    maxIterations?: number;
    timeout?: number;
  }): Promise<string>;

  chatStream(message: string, options?: {
    maxIterations?: number;
  }): AsyncGenerator<string>;
}
```

### `createAgentProxy(agentId, bus, options?)` → `AgentProxy`

Synchronous. Creates the proxy immediately without verifying the agent exists. If the remote agent is unreachable, the first method call throws `NirnamRequestError(NO_HANDLER)` or `NirnamRequestError(TIMEOUT)`.

```ts
interface AgentProxyOptions {
  timeout?: number;  // Default request timeout in ms. Default: 30 000.
}
```

### Request serialisation

Concurrent proxy calls from multiple tabs are automatically serialised on the host agent side. If Tab B and Tab C both call `proxy.chat()` simultaneously, the host agent queues them and processes them one at a time, preventing history corruption.

### IndexedDB history persistence

For `scope: 'page'` agents:
- After each `chat()` or `chatStream()` call, the full internal history is saved to IndexedDB under the key `nirnam-agent-history-v1 / histories / ${agentId}`.
- After `run()` with `retainHistory: true`, history is also saved.
- On the next page load, `_initialize()` automatically restores history before setting status to `'ready'`.
- History is stored using the `nirnam-agent-history-v1` IndexedDB database.

```ts
// Manual access to the history store (for custom persistence logic)
import { saveAgentHistory, loadAgentHistory, deleteAgentHistory } from '@palinc/nirnam/agents/history-store';
// Note: prefer using scope:'page' auto-persistence over direct access.
```

---

## Tool definitions

```ts
interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;   // JSON Schema for each parameter
    required?: string[];
  };
  execute: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<string>;
}
```

`execute` must return a **string** — the tool result string is included verbatim in the next LLM context window.

```ts
const weatherTool: ToolDefinition = {
  name: 'get_weather',
  description: 'Return current weather for a city',
  inputSchema: {
    type: 'object',
    properties: {
      city: { type: 'string', description: 'City name' },
    },
    required: ['city'],
  },
  execute: async ({ city }, signal) => {
    const res = await fetch(`/api/weather?city=${city}`, { signal });
    const data = await res.json() as { temp: number; condition: string };
    return `${data.condition}, ${data.temp}°C`;
  },
};

const agent = createAgent({ llm, tools: [weatherTool] });
```

### Dynamic tool management

```ts
agent.addTool(newTool);     // Add a tool after construction
agent.removeTool('get_weather');  // Remove by name
```

### Expose an agent as a tool

`asTool()` wraps the agent's `run()` method as a `ToolDefinition`, letting one agent call another as a tool.

```ts
const summarizerTool = summarizer.asTool({
  name: 'summarize',
  description: 'Condense long text to bullet points',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
  formatInput: ({ text }) => `Summarize this: ${text}`,
});

orchestrator.addTool(summarizerTool);
```

---

## Filesystem access

The agent can call `read_file`, `write_file`, `list_directory`, `create_directory`, `delete_file`, `move_file` tools after a folder handle is granted.

### Request folder picker (browser native)

```ts
const handle = await agent.requestFolderAccess({ mode: 'readwrite' });
// 'read' | 'readwrite' (default: 'readwrite')
```

### Mount a pre-existing handle

```ts
await agent.mountFolder(existingHandle);
```

### Revoke access

```ts
agent.revokeFolder();
// Removes all 6 filesystem tools from the agent's tool set.
```

### Via config

```ts
// lazy: true (default in presets) — tools registered immediately, handle injected by requestFolderAccess
const agent = createAgent({
  llm,
  filesystem: { mode: 'read', lazy: true },
});

// Direct handle — tools active immediately, no picker needed
const agent = createAgent({
  llm,
  filesystem: { handle: myDirectoryHandle, mode: 'readwrite' },
});
```

**Path safety:** All filesystem tools reject paths containing `..` or absolute paths to prevent directory traversal.

---

## Bus-based agent communication

Agents expose helper methods that wrap the underlying `NirnamBus` with the agent's `agentId` as a namespace prefix.

### Receive requests from other agents

```ts
// Registers handler on topic `${agent.agentId}:inventory:check`
const unsub = agent.handle<{ sku: string }, { stock: number }>(
  'inventory:check',
  async ({ sku }) => ({ stock: await db.stockFor(sku) }),
);
```

### Send requests to other agents

```ts
// Sends request to topic `inventory-agent:inventory:check`
const { stock } = await agent.request<{ sku: string }, { stock: number }>(
  'inventory-agent',   // targetAgentId
  'inventory:check',   // topic suffix
  { sku: 'SKU-007' },
  3000,                // optional timeout
);
```

### Publish / subscribe (plain bus access)

```ts
agent.publish('order:shipped', { orderId: 'ORD-001' });

const unsub = agent.subscribe<{ orderId: string }>('order:shipped', (ev) => {
  console.log('shipped:', ev.orderId);
});
```

Subscriptions registered via `agent.subscribe()` are tracked by the agent and cleaned up automatically on `destroy()`.

---

## Interceptors

Interceptors are middleware functions that run around specific points in the agent loop. They are chained LIFO (last registered, first called).

### `onBeforeToolCall` — intercept or deny tool execution

```ts
const unsub = agent.onBeforeToolCall(async (call, next) => {
  if (call.name === 'delete_file') {
    return { error: 'File deletion is not allowed.' };
  }
  const result = await next(call);
  return result;
});
```

```ts
type ToolCallInterceptor = (
  call: ToolCall,
  next: (call: ToolCall) => Promise<ToolResult>,
) => Promise<ToolResult | { error: string }>;
```

### `onAfterToolCall` — transform tool results

```ts
agent.onAfterToolCall(async (call, result) => {
  return { ...result, content: redact(result.content) };
});
```

### `onBeforeLLMCall` — inspect or modify the message list

```ts
agent.onBeforeLLMCall(async (messages, next) => {
  const withReminder = [
    ...messages,
    { role: 'system' as const, content: 'Remember: be concise.' },
  ];
  return next(withReminder);
});
```

### `onMessage` — observe every user/assistant message

```ts
const unsub = agent.onMessage((msg: Message) => {
  analytics.track('agent_message', { role: msg.role, length: msg.content.length });
});
```

### `onStatusChange` — observe status transitions

```ts
agent.onStatusChange((status: AgentStatus) => {
  console.log('agent status →', status);
});
```

All interceptor registration methods return an `UnsubscribeFn`. Call it to remove the interceptor.

---

## History management

`history` returns the **public** conversation — user and plain assistant messages only. Tool call/result round-trips are in the internal history only.

```ts
const messages: Message[] = agent.history;
// Message = { id: string; role: 'user' | 'assistant'; content: string; timestamp: number }
```

```ts
agent.clearHistory();         // Wipes both public and internal history

const snapshot = agent.exportHistory();   // InternalMessage[] — full internal context
agent.importHistory(snapshot);            // Restore from snapshot (e.g. between sessions)
```

`importHistory` reconstructs both internal and public history from a snapshot, using the same role-filter logic as normal chat.

---

## Lifecycle methods

```ts
agent.stop();     // Aborts in-flight operation; status → 'stopped'. No new ops accepted.
agent.resume();   // Re-enables ops; status → 'ready'. No-op if not stopped.
agent.destroy();  // Irrecoverable. Aborts in-flight, removes all bus subs, closes owned bus.
```

```ts
agent.stats
// {
//   messagesProcessed: number,
//   toolCallsExecuted: number,
//   tokensUsed: number,
//   uptime: number,   // ms since construction
// }
```

```ts
agent.agentId   // string — stable ID for this session
agent.status    // AgentStatus
agent.ready     // Promise<void> — resolves when bus registration is complete
```

---

## Multi-agent topology — `connectAgents`

Wires agents together via the shared bus. **All agents must share the same `NirnamBus` instance** for routing to work.

```ts
import { connectAgents, pipelinePublish, fanOutPublish } from '@palinc/nirnam/agents';

const teardown = connectAgents(agents, { topology, topic });
// teardown() removes all wiring
```

### Pipeline topology

```
input → agents[0] → agents[1] → agents[2] → ...
```

- `agents[0]` is the **source** — it does not process; it just starts the chain.
- `agents[1..n]` each subscribe to the previous stage, call `agent.run()`, and (if not last) publish the result forward.
- The last agent's output is terminal — it does not publish further.

```ts
const sharedBus = createBus();
const summarizer = createAgent({ llm, bus: sharedBus, systemPrompt: 'Summarize...' });
const reviewer   = createAgent({ llm, bus: sharedBus, systemPrompt: 'Review for accuracy...' });

const teardown = connectAgents([summarizer, reviewer], {
  topology: 'pipeline',
  topic: 'doc-pipeline',
});

pipelinePublish(summarizer, 'doc-pipeline', longDocumentText);
teardown();
```

Internal topics: `nirnam:pipeline:{topic}:0`, `:1`, `:2`, ...

### Fan-out topology

```
input → agents[0] → agents[1], agents[2], agents[3] (all in parallel)
```

```ts
const teardown = connectAgents([source, classifierA, classifierB], {
  topology: 'fan-out',
  topic: 'classify-event',
});

fanOutPublish(source, 'classify-event', rawEventText);
```

Internal topic: `nirnam:fanout:{topic}`.

### `pipelinePublish` / `fanOutPublish` helpers

```ts
pipelinePublish(sourceAgent, topic, input);
// Equivalent to: sourceAgent.publish(`nirnam:pipeline:${topic}:0`, input)

fanOutPublish(sourceAgent, topic, input);
// Equivalent to: sourceAgent.publish(`nirnam:fanout:${topic}`, input)
```

---

## Presets

Pre-built config fragments. Always merged with `withPreset()` since they never include `llm`.

```ts
import { presets, withPreset } from '@palinc/nirnam/agents';
```

### `presets.filesystem(options?)`

Read/write filesystem agent with a file-focused system prompt. Registers FS tools lazily (user must call `requestFolderAccess` or `mountFolder`).

```ts
const agent = createAgent(withPreset(presets.filesystem({ mode: 'read' }), { llm }));
```

### `presets.codeReview(options?)`

Read-only filesystem + senior engineer system prompt.

```ts
const agent = createAgent(withPreset(presets.codeReview(), { llm }));
const review = await agent.chat('Review the code in the src/ folder');
```

### `presets.summarizer(options?)`

System prompt focused on neutral, concise summaries. No filesystem.

```ts
const agent = createAgent(withPreset(presets.summarizer(), { llm }));
const summary = await agent.run(longText);
```

### `presets.monitor(options?)`

Passive mode + data monitoring system prompt. Responds in JSON with `{ severity, category, message, suggestion }`.

```ts
const agent = createAgent(withPreset(presets.monitor(), { llm }));
const result = await agent.process('[ERROR] DB connection refused');
const { severity, category, message } = JSON.parse(result);
```

### `withPreset(preset, config)` → `AgentConfig`

```ts
function withPreset(
  preset: Omit<AgentConfig, 'llm'>,
  config: { llm: LLMConfig } & Partial<AgentConfig>,
): AgentConfig
```

Custom properties override preset properties:
```ts
const agent = createAgent(withPreset(
  presets.filesystem(),
  {
    llm,
    systemPrompt: 'Override the default filesystem prompt',
    tools: [myExtraTool],
  }
));
```

---

## React hooks — `@palinc/nirnam/agents/react`

### `useAgent(config)` → `NirnamAgent | null`

Creates an agent on mount, destroys it on unmount. Config is read **once at mount** — changes after mount are ignored. Returns `null` briefly during React's initial render before the effect fires.

```tsx
const agent = useAgent({
  llm: { url: 'http://localhost:11434/v1', model: 'llama3.2' },
  systemPrompt: 'You are a helpful assistant.',
  tools: [myTool],
  autoCleanup: false,  // useAgent handles cleanup on unmount
});
```

### `useAgentChat(agent)` → `AgentChatState`

Manages streaming chat state for an active agent.

```ts
interface AgentChatState {
  messages: Message[];
  send: (text: string) => void;
  isStreaming: boolean;
  error: Error | null;
  clearMessages: () => void;
}
```

```tsx
const agent = useAgent({ llm, ... });
const { messages, send, isStreaming, error, clearMessages } = useAgentChat(agent);
```

`send()` is a no-op if `isStreaming` is true or `agent` is null.
Internally uses `agent.chatStream()`. The streaming assistant message is upserted in-place by its `id` as chunks arrive.

### `useAgentStatus(agent)` → `AgentStatus`

```tsx
const status = useAgentStatus(agent);
// 'initializing' | 'ready' | 'busy' | 'stopped' | 'destroyed'
```

---

## Logging

```ts
interface LoggerConfig {
  level?: 'silent' | 'error' | 'warn' | 'info' | 'debug';  // Default: 'silent'
  transport?: (entry: LogEntry) => void;
}

interface LogEntry {
  level: 'error' | 'warn' | 'info' | 'debug';
  agentId: string;
  message: string;
  data?: unknown;
  timestamp: number;
}
```

---

## Testing utilities — `@palinc/nirnam/agents/testing`

### `mockLLM(config)` → `MockLLMConfig`

```ts
import { mockLLM } from '@palinc/nirnam/agents/testing';

mockLLM({ response: 'Fixed reply' })

mockLLM({
  toolCalls: [{ name: 'get_time', args: {} }],
  afterToolCalls: 'The time is 3:00 PM.',
})

mockLLM({
  handler: (messages) => ({
    content: `echo: ${messages.at(-1)?.content}`,
    toolCalls: [],
    finishReason: 'stop',
    tokensUsed: 42,
  }),
})
```

### `scenarioMock(steps)` → `MockLLMConfig`

Multi-step mock that cycles through a sequence of responses.

```ts
import { scenarioMock } from '@palinc/nirnam/agents/testing';

const llm = scenarioMock([
  { toolCalls: [{ name: 'search', args: { q: 'cats' } }] },
  { response: 'I found 3 cat articles.' },
]);
```

---

## Types quick reference

```ts
// Config
interface AgentConfig { agentId?, llm, mode?, scope?: 'tab' | 'page', systemPrompt?, bus?, tools?, filesystem?, autoCleanup?, logger?, retainHistory? }
interface RealLLMConfig { url, model, apiKey?, provider? }
interface MockLLMConfig { _isMock: true, response?, toolCalls?, afterToolCalls?, handler? }
type LLMConfig = RealLLMConfig | MockLLMConfig;
type LLMProvider = 'openai-compat' | 'anthropic';

// Proxy
class AgentProxy { agentId, chat(msg, opts?), run(task, opts?), chatStream(msg, opts?) }
interface AgentProxyOptions { timeout?: number }
function createAgentProxy(agentId, bus, opts?): AgentProxy

// Agent state
type AgentStatus = 'initializing' | 'ready' | 'busy' | 'stopped' | 'destroyed';
interface AgentStats { messagesProcessed, toolCallsExecuted, tokensUsed, uptime }

// Messages
interface Message { id, role: 'user' | 'assistant', content, timestamp }
interface InternalMessage { role: 'system' | 'user' | 'assistant' | 'tool', content, toolCalls?, toolCallId?, toolName? }

// Tools
interface ToolDefinition { name, description, inputSchema: { type: 'object', properties, required? }, execute }
interface ToolCall { id, name, args }
interface ToolResult { callId, name, content }

// Interceptors
type ToolCallInterceptor = (call, next) => Promise<ToolResult | { error: string }>
type ToolResultInterceptor = (call, result) => ToolResult | Promise<ToolResult>
type BeforeLLMCallInterceptor = (messages, next) => Promise<LLMResponse>
type MessageHandler = (message: Message) => void
type StatusChangeHandler = (status: AgentStatus) => void

// Options
interface ChatOptions { signal?: AbortSignal, maxIterations?: number }
interface ConnectOptions { topology: 'pipeline' | 'fan-out', topic: string }
interface FilesystemOptions { handle?: FileSystemDirectoryHandle, mode?: 'read' | 'readwrite', lazy?: boolean }
interface LoggerConfig { level?, transport? }
```

---

## `NirnamAgent` public API summary

| Member | Type | Description |
|--------|------|-------------|
| `agentId` | `string` | Stable agent ID for this session |
| `status` | `AgentStatus` | Current status (synchronous) |
| `ready` | `Promise<void>` | Resolves after bus registration (+ IDB restore for `scope:'page'`) |
| `stats` | `AgentStats` | Cumulative metrics |
| `history` | `Message[]` | Public chat history (copy) |
| `chat(msg, opts?)` | `Promise<string>` | Full agentic turn, updates history, persists for `scope:'page'` |
| `chatStream(msg, opts?)` | `AsyncGenerator<string>` | Streaming final response |
| `run(task, opts?)` | `Promise<string>` | One-shot, history not persisted by default |
| `process(input)` | `Promise<string>` | Passive-mode processing |
| `stop()` | `void` | Pause; aborts in-flight |
| `resume()` | `void` | Resume after stop |
| `destroy()` | `void` | Permanent teardown |
| `addTool(tool)` | `void` | Add tool dynamically |
| `removeTool(name)` | `void` | Remove tool by name |
| `asTool(opts)` | `ToolDefinition` | Wrap agent's run() as a tool |
| `requestFolderAccess(opts?)` | `Promise<FileSystemDirectoryHandle>` | Show directory picker |
| `mountFolder(handle)` | `Promise<void>` | Mount existing handle |
| `revokeFolder()` | `void` | Remove filesystem tools |
| `handle(topic, handler)` | `UnsubscribeFn` | Register namespaced request handler |
| `request(targetId, topic, payload, timeout?)` | `Promise<Res>` | Request another agent |
| `publish(topic, payload)` | `void` | Bus publish (raw topic) |
| `subscribe(topic, handler)` | `UnsubscribeFn` | Bus subscribe (raw topic) |
| `onBeforeToolCall(fn)` | `UnsubscribeFn` | Intercept / deny tool calls |
| `onAfterToolCall(fn)` | `UnsubscribeFn` | Transform tool results |
| `onBeforeLLMCall(fn)` | `UnsubscribeFn` | Inspect / modify messages |
| `onMessage(fn)` | `UnsubscribeFn` | Observe user/assistant messages |
| `onStatusChange(fn)` | `UnsubscribeFn` | Observe status transitions |
| `clearHistory()` | `void` | Wipe public + internal history |
| `exportHistory()` | `InternalMessage[]` | Full internal context snapshot |
| `importHistory(snapshot)` | `void` | Restore from snapshot |

## `AgentProxy` public API summary

| Member | Type | Description |
|--------|------|-------------|
| `agentId` | `string` | The target agent's ID |
| `chat(msg, opts?)` | `Promise<string>` | Forward chat to host agent via bus |
| `run(task, opts?)` | `Promise<string>` | Forward run to host agent via bus |
| `chatStream(msg, opts?)` | `AsyncGenerator<string>` | Stream from host agent via bus |
