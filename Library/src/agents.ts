/**
 * @palinc/nirnam/agents
 *
 * Browser-native MCP agent layer built on the Nirnam bus.
 *
 * Import this subpath lazily to avoid loading the LLM client until needed:
 *   const { createAgent } = await import('@palinc/nirnam/agents');
 *
 * IMPORTANT — tab and refresh behaviour:
 *   Agents created with createAgent() run in the browser's main thread and are
 *   NOT shared across tabs. Each tab creates its own agent instances. Agents do
 *   NOT survive a page refresh — they must be recreated on each page load.
 *   autoCleanup (default: true) ensures agents deregister from the bus on unload.
 *   Cross-tab agent sharing requires the Layer 3 static SharedWorker and is
 *   planned for a future major version.
 */

export { NirnamAgent, createAgent } from './agents/agent';
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
