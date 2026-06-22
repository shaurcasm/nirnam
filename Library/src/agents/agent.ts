import { createBus } from '../bus';
import type { NirnamBus } from '../bus';
import type { UnsubscribeFn, RequestHandler, SubscribeHandler } from '../types';
import { callLLM, callLLMStream } from './llm-client';
import { buildFilesystemTools } from './fs-tools';
import type {
  AgentConfig,
  AgentStatus,
  AgentStats,
  ChatOptions,
  AsToolOptions,
  Message,
  InternalMessage,
  ToolCall,
  ToolDefinition,
  ToolResult,
  ToolCallInterceptor,
  ToolResultInterceptor,
  BeforeLLMCallInterceptor,
  MessageHandler,
  StatusChangeHandler,
  LogEntry,
  LLMResponse,
} from './types';

let idCounter = 0;
function genId(): string {
  return `${Date.now().toString(36)}-${(++idCounter).toString(36)}`;
}

const LOG_LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 } as const;

export class NirnamAgent {
  readonly agentId: string;
  readonly ready: Promise<void>;

  private readonly _config: AgentConfig;
  private readonly _bus: NirnamBus;
  private readonly _ownsBus: boolean;
  private readonly _tools: Map<string, ToolDefinition> = new Map();
  private readonly _busUnsubs: UnsubscribeFn[] = [];
  private readonly _beforeToolCall: ToolCallInterceptor[] = [];
  private readonly _afterToolCall: ToolResultInterceptor[] = [];
  private readonly _beforeLLMCall: BeforeLLMCallInterceptor[] = [];
  private readonly _messageHandlers: Set<MessageHandler> = new Set();
  private readonly _statusHandlers: Set<StatusChangeHandler> = new Set();
  private readonly _internalHistory: InternalMessage[] = [];
  private readonly _publicHistory: Message[] = [];
  private _fsHandle: FileSystemDirectoryHandle | null = null;
  private _status: AgentStatus = 'initializing';
  private _currentAbort: AbortController | null = null;
  private _startTime: number;
  private _stats: AgentStats = { messagesProcessed: 0, toolCallsExecuted: 0, tokensUsed: 0, uptime: 0 };

  constructor(config: AgentConfig) {
    this._config = config;
    this.agentId = config.agentId ?? genId();
    this._startTime = Date.now();

    if (config.bus) {
      this._bus = config.bus;
      this._ownsBus = false;
    } else {
      this._bus = createBus();
      this._ownsBus = true;
    }

    for (const tool of config.tools ?? []) {
      this._tools.set(tool.name, tool);
    }

    if (config.filesystem?.handle) {
      this._fsHandle = config.filesystem.handle;
      this._mountFsTools();
    } else if (config.filesystem && !config.filesystem.lazy) {
      // Eager non-lazy: tools registered now, handle injected when granted
      this._mountFsTools();
    }

    this.ready = this._initialize();
  }

  // ---- Lifecycle ------------------------------------------------------------

  private async _initialize(): Promise<void> {
    this._bus.register({
      agentId: this.agentId,
      capabilities: [...this._tools.keys()],
      metadata: { mode: this._config.mode ?? 'active' },
    });

    if (this._config.autoCleanup !== false && typeof window !== 'undefined') {
      const onUnload = () => this.destroy();
      window.addEventListener('beforeunload', onUnload);
      this._busUnsubs.push(() => window.removeEventListener('beforeunload', onUnload));
    }

    this._setStatus('ready');
  }

  stop(): void {
    if (this._status === 'destroyed') return;
    this._currentAbort?.abort(new Error('[NirnamAgent] Agent stopped.'));
    this._setStatus('stopped');
  }

  resume(): void {
    if (this._status !== 'stopped') return;
    this._setStatus('ready');
  }

  destroy(): void {
    if (this._status === 'destroyed') return;
    this._currentAbort?.abort(new Error('[NirnamAgent] Agent destroyed.'));
    for (const unsub of this._busUnsubs) unsub();
    this._busUnsubs.length = 0;
    if (this._ownsBus) this._bus.close();
    this._setStatus('destroyed');
    this._log('info', 'Agent destroyed.');
  }

  // ---- Status / stats -------------------------------------------------------

  get status(): AgentStatus { return this._status; }

  get stats(): AgentStats {
    return { ...this._stats, uptime: Date.now() - this._startTime };
  }

  private _setStatus(s: AgentStatus): void {
    this._status = s;
    this._statusHandlers.forEach(h => h(s));
  }

  // ---- Tool management ------------------------------------------------------

  addTool(tool: ToolDefinition): void {
    this._tools.set(tool.name, tool);
  }

  removeTool(name: string): void {
    this._tools.delete(name);
  }

  asTool(options: AsToolOptions): ToolDefinition {
    const self = this;
    return {
      name: options.name,
      description: options.description,
      inputSchema: options.inputSchema,
      async execute(args, signal) {
        const input = options.formatInput
          ? options.formatInput(args)
          : (typeof args.text === 'string' ? args.text : JSON.stringify(args));
        return self.run(input, { signal });
      },
    };
  }

  // ---- Filesystem -----------------------------------------------------------

  async requestFolderAccess(
    opts: { mode?: 'read' | 'readwrite' } = {},
  ): Promise<FileSystemDirectoryHandle> {
    type PickerFn = (opts?: { mode?: string }) => Promise<FileSystemDirectoryHandle>;
    const picker = (window as unknown as Record<string, unknown>)['showDirectoryPicker'] as PickerFn | undefined;
    if (typeof picker !== 'function') {
      throw new Error('[NirnamAgent] File System Access API is not supported in this browser.');
    }
    const handle = await picker({ mode: opts.mode ?? 'readwrite' });
    await this.mountFolder(handle);
    return handle;
  }

  async mountFolder(handle: FileSystemDirectoryHandle): Promise<void> {
    this._fsHandle = handle;
    this._mountFsTools();
    this._log('info', `Folder "${handle.name}" mounted.`);
  }

  revokeFolder(): void {
    this._fsHandle = null;
    for (const name of ['read_file', 'write_file', 'list_directory', 'create_directory', 'delete_file', 'move_file']) {
      this._tools.delete(name);
    }
    this._log('info', 'Folder access revoked.');
  }

  private _mountFsTools(): void {
    for (const tool of buildFilesystemTools(() => this._fsHandle)) {
      this._tools.set(tool.name, tool);
    }
  }

  // ---- Bus-based agent communication ----------------------------------------

  handle<Req, Res>(topic: string, handler: RequestHandler<Req, Res>): UnsubscribeFn {
    const unsub = this._bus.handle<Req, Res>(`${this.agentId}:${topic}`, handler);
    this._busUnsubs.push(unsub);
    return unsub;
  }

  request<Req, Res>(
    targetAgentId: string,
    topic: string,
    payload: Req,
    timeout?: number,
  ): Promise<Res> {
    return this._bus.request<Req, Res>(`${targetAgentId}:${topic}`, payload, timeout);
  }

  publish<T>(topic: string, payload: T): void {
    this._bus.publish<T>(topic, payload);
  }

  subscribe<T>(topic: string, handler: SubscribeHandler<T>): UnsubscribeFn {
    const unsub = this._bus.subscribe<T>(topic, handler);
    this._busUnsubs.push(unsub);
    return unsub;
  }

  // ---- Interceptors ---------------------------------------------------------

  onBeforeToolCall(interceptor: ToolCallInterceptor): UnsubscribeFn {
    this._beforeToolCall.push(interceptor);
    return () => {
      const i = this._beforeToolCall.indexOf(interceptor);
      if (i !== -1) this._beforeToolCall.splice(i, 1);
    };
  }

  onAfterToolCall(interceptor: ToolResultInterceptor): UnsubscribeFn {
    this._afterToolCall.push(interceptor);
    return () => {
      const i = this._afterToolCall.indexOf(interceptor);
      if (i !== -1) this._afterToolCall.splice(i, 1);
    };
  }

  onBeforeLLMCall(interceptor: BeforeLLMCallInterceptor): UnsubscribeFn {
    this._beforeLLMCall.push(interceptor);
    return () => {
      const i = this._beforeLLMCall.indexOf(interceptor);
      if (i !== -1) this._beforeLLMCall.splice(i, 1);
    };
  }

  onMessage(handler: MessageHandler): UnsubscribeFn {
    this._messageHandlers.add(handler);
    return () => this._messageHandlers.delete(handler);
  }

  onStatusChange(handler: StatusChangeHandler): UnsubscribeFn {
    this._statusHandlers.add(handler);
    return () => this._statusHandlers.delete(handler);
  }

  // ---- History --------------------------------------------------------------

  get history(): Message[] { return [...this._publicHistory]; }

  clearHistory(): void {
    this._internalHistory.length = 0;
    this._publicHistory.length = 0;
  }

  exportHistory(): InternalMessage[] {
    return [...this._internalHistory];
  }

  importHistory(snapshot: InternalMessage[]): void {
    this._internalHistory.length = 0;
    this._internalHistory.push(...snapshot);
    this._publicHistory.length = 0;
    for (const msg of snapshot) {
      if (msg.role === 'user' || (msg.role === 'assistant' && msg.content && !msg.toolCalls?.length)) {
        this._publicHistory.push({
          id: genId(),
          role: msg.role as 'user' | 'assistant',
          content: msg.content ?? '',
          timestamp: Date.now(),
        });
      }
    }
  }

  // ---- Core chat methods ----------------------------------------------------

  async chat(message: string, options?: ChatOptions): Promise<string> {
    this._assertActive();
    const abort = this._beginOperation(options?.signal);

    this._addUserMessage(message);

    try {
      return await this._runLoop(abort.signal, options?.maxIterations ?? 10);
    } finally {
      this._endOperation(abort);
    }
  }

  async *chatStream(message: string, options?: ChatOptions): AsyncGenerator<string> {
    this._assertActive();
    const abort = this._beginOperation(options?.signal);

    this._addUserMessage(message);

    try {
      // Run tool loop with non-streaming calls until no more tool calls
      const maxIter = (options?.maxIterations ?? 10) - 1;
      let iterations = 0;
      while (iterations < maxIter) {
        abort.signal.throwIfAborted();
        const response = await this._callLLMWithInterceptors(this._buildMessages(), abort.signal);
        if (response.toolCalls.length === 0) break;
        await this._handleToolCalls(response.toolCalls, abort.signal);
        iterations++;
      }

      // Stream the final response
      let accumulated = '';
      for await (const chunk of callLLMStream(this._config.llm, this._buildMessages(), abort.signal)) {
        accumulated += chunk;
        yield chunk;
      }

      // Commit final message to history
      this._addAssistantMessage(accumulated);
      this._stats.messagesProcessed++;
    } finally {
      this._endOperation(abort);
    }
  }

  async run(task: string, options?: ChatOptions): Promise<string> {
    this._assertActive();
    const abort = this._beginOperation(options?.signal);
    const savedHistory = this.exportHistory();

    this._addUserMessage(task);

    try {
      const result = await this._runLoop(abort.signal, options?.maxIterations ?? 10);
      // Restore history: run() doesn't persist conversation
      if (!this._config.retainHistory) {
        this._internalHistory.length = 0;
        this._internalHistory.push(...savedHistory);
        this._publicHistory.length = 0;
        for (const m of savedHistory) {
          if (m.role === 'user' || (m.role === 'assistant' && m.content && !m.toolCalls?.length)) {
            this._publicHistory.push({ id: genId(), role: m.role as 'user' | 'assistant', content: m.content!, timestamp: Date.now() });
          }
        }
      }
      return result;
    } finally {
      this._endOperation(abort);
    }
  }

  async process(input: string): Promise<string> {
    if (this._config.mode !== 'passive') {
      this._log('warn', 'process() is intended for passive agents. Use chat() or run() for active agents.');
    }
    this._assertActive();
    const abort = this._beginOperation();

    const messages: InternalMessage[] = [];
    if (this._config.systemPrompt) messages.push({ role: 'system', content: this._config.systemPrompt });
    if (this._config.retainHistory) messages.push(...this._internalHistory);
    messages.push({ role: 'user', content: input });

    try {
      const response = await this._callLLMWithInterceptors(messages, abort.signal);
      const content = response.content ?? '';
      if (this._config.retainHistory) {
        this._internalHistory.push({ role: 'user', content: input });
        this._internalHistory.push({ role: 'assistant', content });
      }
      if (response.tokensUsed) this._stats.tokensUsed += response.tokensUsed;
      return content;
    } finally {
      this._endOperation(abort);
    }
  }

  // ---- Private helpers ------------------------------------------------------

  private _assertActive(): void {
    if (this._status === 'stopped') throw new Error(`[NirnamAgent] Agent "${this.agentId}" is stopped. Call resume() first.`);
    if (this._status === 'destroyed') throw new Error(`[NirnamAgent] Agent "${this.agentId}" has been destroyed.`);
  }

  private _beginOperation(outerSignal?: AbortSignal): AbortController {
    const ctrl = new AbortController();
    if (outerSignal) {
      if (outerSignal.aborted) ctrl.abort(outerSignal.reason);
      else outerSignal.addEventListener('abort', () => ctrl.abort(outerSignal.reason), { once: true });
    }
    this._currentAbort = ctrl;
    this._setStatus('busy');
    return ctrl;
  }

  private _endOperation(ctrl: AbortController): void {
    if (this._currentAbort === ctrl) this._currentAbort = null;
    if (this._status === 'busy') this._setStatus('ready');
  }

  private _buildMessages(): InternalMessage[] {
    const msgs: InternalMessage[] = [];
    if (this._config.systemPrompt) msgs.push({ role: 'system', content: this._config.systemPrompt });
    return [...msgs, ...this._internalHistory];
  }

  private _addUserMessage(content: string): void {
    this._internalHistory.push({ role: 'user', content });
    const pub: Message = { id: genId(), role: 'user', content, timestamp: Date.now() };
    this._publicHistory.push(pub);
    this._messageHandlers.forEach(h => h(pub));
  }

  private _addAssistantMessage(content: string): void {
    this._internalHistory.push({ role: 'assistant', content });
    const pub: Message = { id: genId(), role: 'assistant', content, timestamp: Date.now() };
    this._publicHistory.push(pub);
    this._messageHandlers.forEach(h => h(pub));
  }

  private async _callLLMWithInterceptors(
    messages: InternalMessage[],
    signal: AbortSignal,
  ): Promise<LLMResponse> {
    const tools = [...this._tools.values()];
    const callFn = (msgs: InternalMessage[]): Promise<LLMResponse> =>
      callLLM(this._config.llm, msgs, tools, signal);

    let chain = callFn;
    for (let i = this._beforeLLMCall.length - 1; i >= 0; i--) {
      const interceptor = this._beforeLLMCall[i];
      const next = chain;
      chain = (msgs) => interceptor(msgs, next);
    }

    const response = await chain(messages);
    if (response.tokensUsed) this._stats.tokensUsed += response.tokensUsed;
    return response;
  }

  private async _runLoop(signal: AbortSignal, maxIterations: number): Promise<string> {
    let iterations = 0;

    while (iterations < maxIterations) {
      signal.throwIfAborted();
      const response = await this._callLLMWithInterceptors(this._buildMessages(), signal);

      if (response.toolCalls.length === 0) {
        const content = response.content ?? '';
        this._addAssistantMessage(content);
        this._stats.messagesProcessed++;
        return content;
      }

      await this._handleToolCalls(response.toolCalls, signal);
      iterations++;
    }

    const msg = '[NirnamAgent] Max tool iterations reached without a final response.';
    this._log('warn', msg);
    return msg;
  }

  private async _handleToolCalls(toolCalls: ToolCall[], signal: AbortSignal): Promise<void> {
    // Append assistant message with tool calls to history
    this._internalHistory.push({ role: 'assistant', content: null, toolCalls });

    // Execute each tool call through the interceptor chain
    const results: ToolResult[] = await Promise.all(
      toolCalls.map(call => this._executeToolCall(call, signal)),
    );

    // Append tool result messages
    for (const result of results) {
      this._internalHistory.push({
        role: 'tool',
        content: result.content,
        toolCallId: result.callId,
        toolName: result.name,
      });
    }
  }

  private async _executeToolCall(call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
    const execute = async (c: ToolCall): Promise<ToolResult> => {
      const tool = this._tools.get(c.name);
      if (!tool) {
        return { callId: c.id, name: c.name, content: `Error: Tool "${c.name}" is not registered on this agent.` };
      }
      try {
        const output = await tool.execute(c.args, signal);
        this._stats.toolCallsExecuted++;
        this._log('debug', `Tool "${c.name}" executed.`, { args: c.args });
        return { callId: c.id, name: c.name, content: output };
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        this._log('warn', `Tool "${c.name}" threw: ${msg}`);
        return { callId: c.id, name: c.name, content: `Error: ${msg}` };
      }
    };

    // Chain before-tool-call interceptors (outermost first)
    let interceptorIdx = 0;
    const chain = async (c: ToolCall): Promise<ToolResult> => {
      if (interceptorIdx < this._beforeToolCall.length) {
        const interceptor = this._beforeToolCall[interceptorIdx++];
        const r = await interceptor(c, chain);
        if ('error' in r) {
          return { callId: c.id, name: c.name, content: `Denied: ${(r as { error: string }).error}` };
        }
        return r as ToolResult;
      }
      return execute(c);
    };

    let result = await chain(call);

    // Chain after-tool-call interceptors
    for (const interceptor of this._afterToolCall) {
      result = await interceptor(call, result);
    }

    return result;
  }

  private _log(level: LogEntry['level'], message: string, data?: unknown): void {
    const cfg = this._config.logger;
    const configLevel = cfg?.level ?? (typeof process !== 'undefined' && process.env?.NODE_ENV === 'production' ? 'silent' : 'info');
    if (LOG_LEVELS[configLevel] >= LOG_LEVELS[level]) {
      const entry: LogEntry = { level, agentId: this.agentId, message, data, timestamp: Date.now() };
      if (cfg?.transport) {
        cfg.transport(entry);
      } else {
        const fn = level === 'error' ? console.error
          : level === 'warn' ? console.warn
          : level === 'debug' ? console.debug
          : console.info;
        fn(`[NirnamAgent:${this.agentId}] ${message}`, data ?? '');
      }
    }
  }
}

export function createAgent(config: AgentConfig): NirnamAgent {
  return new NirnamAgent(config);
}
