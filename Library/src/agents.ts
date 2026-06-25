/**
 * @palinc/nirnam/agents
 *
 * Browser-native MCP agent layer built on the Nirnam bus.
 *
 * Import this subpath lazily to avoid loading the LLM client until needed:
 *   const { createAgent } = await import('@palinc/nirnam/agents');
 *
 * Tab vs page scope:
 *   `scope: 'tab'` (default) — agent lives in this tab only.
 *   `scope: 'page'` — agent registers bus handlers so any tab can call it via
 *   `createAgentProxy()`.  Requires a Layer 3 (static URL SharedWorker) bus for
 *   true cross-tab routing.  History is persisted to IndexedDB automatically.
 */

export { NirnamAgent, createAgent } from './agents/agent';
export { AgentProxy, createAgentProxy } from './agents/agent-proxy';
export { connectAgents, pipelinePublish, fanOutPublish } from './agents/connect';
export { presets, withPreset } from './agents/presets';

export type {
  AgentConfig,
  AgentStatus,
  AgentStats,
  Message,
  InternalMessage,
  ToolCall,
  ToolResult,
  ToolDefinition,
  ToolCallInterceptor,
  ToolResultInterceptor,
  BeforeLLMCallInterceptor,
  MessageHandler,
  StatusChangeHandler,
  ChatOptions,
  AsToolOptions,
  ConnectOptions,
  AgentTopology,
  LLMConfig,
  RealLLMConfig,
  MockLLMConfig,
  LLMProvider,
  FilesystemOptions,
  LoggerConfig,
  LogEntry,
} from './agents/types';

export type { AgentProxyOptions, PageChatRequest, PageRunRequest } from './agents/agent-proxy';
