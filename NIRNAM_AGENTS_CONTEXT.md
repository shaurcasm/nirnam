# @palinc/nirnam/agents — Agent API Context

> Authoritative reference for the Nirnam agentic layer: NirnamAgent, LLM integration,
> tool use, filesystem, bus communication, interceptors, multi-agent topologies, presets,
> and React hooks. Generated from source — keep in sync with `Library/src/agents/`.

---

## What is a NirnamAgent?

A `NirnamAgent` is a **browser-native LLM agent** that runs in the main thread.
It owns an agentic loop (LLM → parse → tool calls → repeat) and communicates with
other agents or MFEs through the Nirnam SharedWorker bus.

**Important constraints:**
- Agents live in the **main thread** of the tab that created them. They do not survive page refresh.
- Each tab creates its own agent instances — agents are NOT shared across browser tabs.
- `autoCleanup: true` (default) hooks `beforeunload` to call `destroy()` automatically.
- Cross-tab agent sharing requires Layer 3 (static SharedWorker) and is not yet implemented.

---

## Import paths

```ts
import { createAgent, connectAgents, pipelinePublish, fanOutPublish,
         presets, withPreset } from '@palinc/nirnam/agents';
import type { AgentConfig, NirnamAgent, AgentStatus, AgentStats,
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
```

---

## `AgentConfig`

```ts
interface AgentConfig {
  agentId?: string;               // Auto-generated if omitted (stable for the session)
  llm: LLMConfig;                 // Required. Real LLM or mock.
  mode?: 'active' | 'passive';    // Default: 'active'
  systemPrompt?: string;
  bus?: NirnamBus;                // Use an external bus. Omit to create a private one.
  tools?: ToolDefinition[];       // Initial tool set. More can be added later.
  filesystem?: FilesystemOptions; // Enable filesystem tools.
  autoCleanup?: boolean;          // Default: true — destroys agent on page unload.
  logger?: LoggerConfig;          // Default: silent.
  retainHistory?: boolean;        // Default: false — run() restores history after each call.
}
```

### `mode: 'active'` vs `mode: 'passive'`

| | `active` (default) | `passive` |
|---|---|---|
| Public history | Yes (`agent.history`) | No (empty) |
| Use `chat()` | Yes | No (warn) |
| Use `run()` | Yes | Yes |
| Use `process()` | Warns, still works | Intended use |
| System prompt role | Depends on LLM | Same |

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

- `initializing` → transitions to `ready` after the bus registration completes.
- `busy` → set while `chat()`, `chatStream()`, `run()`, or `process()` is in progress.
- `stopped` → set by `stop()`. Calling chat/run/process throws. Resume with `resume()`.
- `destroyed` → set by `destroy()`. All bus subscriptions removed. Cannot be resumed.

Calling `chat()` / `run()` / `process()` on a `stopped` or `destroyed` agent throws immediately.

---

## Core conversation methods

### `agent.chat(message, options?)` → `Promise<string>`

Full agentic loop. Runs LLM → parses tool calls → executes tools → feeds results → repeats until no tool calls or `maxIterations` reached. Updates public `history`.

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

Same as `chat()` but streams the **final** LLM response token-by-token. Tool calls before the final response are resolved non-streaming.

```ts
for await (const chunk of agent.chatStream('Tell me a story about MFEs')) {
  process.stdout.write(chunk);
}
```

The generator yields string chunks as they arrive from the LLM. Accumulated text is committed to history when the stream ends.

### `agent.run(task, options?)` → `Promise<string>`

One-shot task execution. Runs the agentic loop (LLM + tools), returns the final string, then **restores history** to pre-call state (unless `retainHistory: true`).

```ts
const summary = await agent.run('Summarize: The quick brown fox...');
// agent.history is unchanged after this call
```

Use `run()` for pipeline stages and background tasks where the call should not pollute the chat context.

### `agent.process(input)` → `Promise<string>`

Passive-mode processing without maintaining public history. Intended for `mode: 'passive'` agents; calling it on an active agent logs a warning.

```ts
// Passive monitor agent
const result = await agent.process('[ERROR] Database connection refused');
// Returns JSON classification, does not update agent.history
```

With `retainHistory: true`, `process()` accumulates context across calls internally:
```ts
const agent = createAgent({ ..., retainHistory: true, mode: 'passive' });
await agent.process('log event 1');
await agent.process('log event 2');  // LLM sees both in context
```

### Method comparison

| Method | Updates `history` | Restores history after | Tool loop | Streaming |
|--------|------------------|-----------------------|-----------|-----------|
| `chat()` | Yes | — (persists) | Yes | No |
| `chatStream()` | Yes | — (persists) | Yes (non-stream) | Yes (final) |
| `run()` | During call only* | Yes (default) | Yes | No |
| `process()` | No (passive) | — | No | No |

*`run()` restores history after completing unless `retainHistory: true`.

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
  // Optional: format how args are passed to run()
  formatInput: ({ text }) => `Summarize this: ${text}`,
});

orchestrator.addTool(summarizerTool);
```

---

## Filesystem access

The agent can call `read_file`, `write_file`, `list_directory`, `create_directory`, `delete_file`, `move_file` tools after a folder handle is granted.

### Request folder picker (browser native)

```ts
// Opens the browser's directory picker; user selects a folder.
const handle = await agent.requestFolderAccess({ mode: 'readwrite' });
// 'read' | 'readwrite' (default: 'readwrite')
```

### Mount a pre-existing handle

```ts
// If you already have a FileSystemDirectoryHandle (e.g. from a previous session)
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
    // Deny: return error object
    return { error: 'File deletion is not allowed.' };
  }
  // Allow: call next() to proceed
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
  // Redact sensitive data before it enters the LLM context
  return { ...result, content: redact(result.content) };
});
```

```ts
type ToolResultInterceptor = (
  call: ToolCall,
  result: ToolResult,
) => ToolResult | Promise<ToolResult>;
```

### `onBeforeLLMCall` — inspect or modify the message list

```ts
agent.onBeforeLLMCall(async (messages, next) => {
  // Inject a reminder message before every LLM call
  const withReminder = [
    ...messages,
    { role: 'system' as const, content: 'Remember: be concise.' },
  ];
  return next(withReminder);
});
```

```ts
type BeforeLLMCallInterceptor = (
  messages: InternalMessage[],
  next: (messages: InternalMessage[]) => Promise<LLMResponse>,
) => Promise<LLMResponse>;
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

// Kick off the pipeline — summarizer receives this as input
pipelinePublish(summarizer, 'doc-pipeline', longDocumentText);

// Clean up wiring (not the agents themselves)
teardown();
```

Internal topics: `nirnam:pipeline:{topic}:0`, `:1`, `:2`, ...

### Fan-out topology

```
input → agents[0] → agents[1], agents[2], agents[3] (all in parallel)
```

- `agents[0]` is the source.
- All other agents receive the same input and process it independently via `agent.run()`.

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

Merges a preset into a full config. `config` always takes precedence (spread after preset).

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
    systemPrompt: 'Override the default filesystem prompt',  // overrides preset's systemPrompt
    tools: [myExtraTool],  // added on top
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

To recreate the agent when config changes, key the component:

```tsx
<ChatPanel key={JSON.stringify(llmConfig)} llm={llmConfig} />
```

### `useAgentChat(agent)` → `AgentChatState`

Manages streaming chat state for an active agent.

```ts
interface AgentChatState {
  messages: Message[];      // User + assistant messages (public history)
  send: (text: string) => void;  // Start a streaming chat turn
  isStreaming: boolean;
  error: Error | null;
  clearMessages: () => void; // Clears UI messages + calls agent.clearHistory()
}
```

```tsx
const agent = useAgent({ llm, ... });
const { messages, send, isStreaming, error, clearMessages } = useAgentChat(agent);

// Render messages
messages.map(m => <div key={m.id}>[{m.role}] {m.content}</div>)

// Send a message
<button onClick={() => send('Hello!')}>Send</button>
```

`send()` is a no-op if `isStreaming` is true or `agent` is null.
Internally uses `agent.chatStream()`. The streaming assistant message is upserted in-place by its `id` as chunks arrive.

### `useAgentStatus(agent)` → `AgentStatus`

Subscribes to an agent's status and re-renders on change.

```tsx
const status = useAgentStatus(agent);
// 'initializing' | 'ready' | 'busy' | 'stopped' | 'destroyed'
```

---

## Logging

```ts
interface LoggerConfig {
  level?: 'silent' | 'error' | 'warn' | 'info' | 'debug';  // Default: 'silent'
  transport?: (entry: LogEntry) => void;  // Custom log handler
}

interface LogEntry {
  level: 'error' | 'warn' | 'info' | 'debug';
  agentId: string;
  message: string;
  data?: unknown;
  timestamp: number;
}
```

```ts
const agent = createAgent({
  llm,
  logger: {
    level: 'debug',
    transport: (entry) => console.log(`[${entry.level}] ${entry.message}`, entry.data),
  },
});
```

---

## Testing utilities — `@palinc/nirnam/agents/testing`

### `mockLLM(config)` → `MockLLMConfig`

Creates a mock LLM config for use with `createAgent`. No network calls made.

```ts
import { mockLLM } from '@palinc/nirnam/agents/testing';

// Static string response
mockLLM({ response: 'Fixed reply' })

// Scripted tool call + follow-up response
mockLLM({
  toolCalls: [{ name: 'get_time', args: {} }],
  afterToolCalls: 'The time is 3:00 PM.',
})

// Custom handler — full control
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

Each step is consumed in order. If the agent makes more calls than steps, the last step repeats (or throws — configurable).

---

## Types quick reference

```ts
// Config
interface AgentConfig { agentId?, llm, mode?, systemPrompt?, bus?, tools?, filesystem?, autoCleanup?, logger?, retainHistory? }
interface RealLLMConfig { url, model, apiKey?, provider? }
interface MockLLMConfig { _isMock: true, response?, toolCalls?, afterToolCalls?, handler? }
type LLMConfig = RealLLMConfig | MockLLMConfig;
type LLMProvider = 'openai-compat' | 'anthropic';

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
| `ready` | `Promise<void>` | Resolves after bus registration |
| `stats` | `AgentStats` | Cumulative metrics |
| `history` | `Message[]` | Public chat history (copy) |
| `chat(msg, opts?)` | `Promise<string>` | Full agentic turn, updates history |
| `chatStream(msg, opts?)` | `AsyncGenerator<string>` | Streaming final response |
| `run(task, opts?)` | `Promise<string>` | One-shot, history not persisted |
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
