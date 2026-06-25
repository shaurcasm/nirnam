import type { NirnamBus } from '../bus';
import type { RequestHandler, SubscribeHandler, UnsubscribeFn } from '../types';

export type LLMProvider = 'openai-compat' | 'anthropic';

export interface RealLLMConfig {
  url: string;
  model: string;
  apiKey?: string;
  provider?: LLMProvider;
}

export interface MockLLMConfig {
  _isMock: true;
  response?: string;
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
  afterToolCalls?: string;
  handler?: (messages: InternalMessage[]) => LLMResponse;
}

export type LLMConfig = RealLLMConfig | MockLLMConfig;

export function isMockLLM(config: LLMConfig): config is MockLLMConfig {
  return '_isMock' in config && config._isMock === true;
}

export function detectProvider(config: RealLLMConfig): LLMProvider {
  if (config.provider) return config.provider;
  if (config.url.includes('anthropic.com')) return 'anthropic';
  return 'openai-compat';
}

export interface FilesystemOptions {
  handle?: FileSystemDirectoryHandle;
  mode?: 'read' | 'readwrite';
  lazy?: boolean;
}

export interface LogEntry {
  level: 'error' | 'warn' | 'info' | 'debug';
  agentId: string;
  message: string;
  data?: unknown;
  timestamp: number;
}

export interface LoggerConfig {
  level?: 'silent' | 'error' | 'warn' | 'info' | 'debug';
  transport?: (entry: LogEntry) => void;
}

export interface AgentConfig {
  agentId?: string;
  llm: LLMConfig;
  mode?: 'active' | 'passive';
  /**
   * `'tab'` (default): agent lives in this tab only, no cross-tab sharing.
   * `'page'`: agent registers bus handlers so other tabs can call it via an
   * `AgentProxy`.  Requires a Layer 3 (static URL SharedWorker) bus for
   * true cross-tab routing.  History is automatically persisted to IndexedDB
   * and restored on the next page load when a stable `agentId` is provided.
   */
  scope?: 'tab' | 'page';
  systemPrompt?: string;
  bus?: NirnamBus;
  tools?: ToolDefinition[];
  filesystem?: FilesystemOptions;
  autoCleanup?: boolean;
  logger?: LoggerConfig;
  retainHistory?: boolean;
}

export type AgentStatus = 'initializing' | 'ready' | 'busy' | 'stopped' | 'destroyed';

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface InternalMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  callId: string;
  name: string;
  content: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  execute: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<string>;
}

export type ToolCallInterceptor = (
  call: ToolCall,
  next: (call: ToolCall) => Promise<ToolResult>,
) => Promise<ToolResult | { error: string }>;

export type ToolResultInterceptor = (
  call: ToolCall,
  result: ToolResult,
) => ToolResult | Promise<ToolResult>;

export type BeforeLLMCallInterceptor = (
  messages: InternalMessage[],
  next: (messages: InternalMessage[]) => Promise<LLMResponse>,
) => Promise<LLMResponse>;

export type MessageHandler = (message: Message) => void;
export type StatusChangeHandler = (status: AgentStatus) => void;

export interface LLMResponse {
  content: string | null;
  toolCalls: ToolCall[];
  finishReason: 'stop' | 'tool_calls' | 'length' | 'error';
  tokensUsed?: number;
}

export interface AgentStats {
  messagesProcessed: number;
  toolCallsExecuted: number;
  tokensUsed: number;
  uptime: number;
}

export interface ChatOptions {
  signal?: AbortSignal;
  maxIterations?: number;
}

export interface AsToolOptions {
  name: string;
  description: string;
  inputSchema: ToolDefinition['inputSchema'];
  formatInput?: (args: Record<string, unknown>) => string;
}

export type AgentTopology = 'pipeline' | 'fan-out';

export interface ConnectOptions {
  topology: AgentTopology;
  topic: string;
}

export type {
  NirnamBus,
  RequestHandler,
  SubscribeHandler,
  UnsubscribeFn,
};
