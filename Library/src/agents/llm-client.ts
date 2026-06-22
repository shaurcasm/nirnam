import type {
  RealLLMConfig,
  MockLLMConfig,
  LLMConfig,
  LLMResponse,
  ToolCall,
  ToolDefinition,
  InternalMessage,
} from './types';
import { isMockLLM, detectProvider } from './types';

// ---- Internal provider-specific request/response shapes -------------------

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OpenAIMessage {
  role: string;
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

interface AnthropicContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
}

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

// ---- OpenAI-compat normalization ------------------------------------------

function toOpenAIMessages(messages: InternalMessage[]): OpenAIMessage[] {
  return messages.map((msg): OpenAIMessage => {
    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: msg.content ?? null,
        tool_calls: msg.toolCalls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.args) },
        })),
      };
    }
    if (msg.role === 'tool') {
      return { role: 'tool', content: msg.content ?? '', tool_call_id: msg.toolCallId! };
    }
    return { role: msg.role, content: msg.content ?? '' };
  });
}

function toOpenAITools(tools: ToolDefinition[]) {
  return tools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}

function parseOpenAIResponse(body: Record<string, unknown>): LLMResponse {
  const choices = body.choices as Array<{
    message: OpenAIMessage;
    finish_reason: string;
  }>;
  const msg = choices[0].message;
  const finishReason = choices[0].finish_reason;
  const usage = body.usage as { total_tokens?: number } | undefined;

  const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map(tc => ({
    id: tc.id,
    name: tc.function.name,
    args: (() => {
      try { return JSON.parse(tc.function.arguments) as Record<string, unknown>; }
      catch { return {} as Record<string, unknown>; }
    })(),
  }));

  return {
    content: msg.content ?? null,
    toolCalls,
    finishReason: finishReason === 'tool_calls' ? 'tool_calls'
      : finishReason === 'length' ? 'length'
      : 'stop',
    tokensUsed: usage?.total_tokens,
  };
}

// ---- Anthropic normalization -----------------------------------------------

function toAnthropicMessages(messages: InternalMessage[]): {
  system: string | undefined;
  messages: AnthropicMessage[];
} {
  let system: string | undefined;
  const out: AnthropicMessage[] = [];
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i];

    if (msg.role === 'system') {
      system = msg.content ?? undefined;
      i++;
      continue;
    }

    if (msg.role === 'tool') {
      // Batch consecutive tool result messages into one user message
      const toolResults: AnthropicContentBlock[] = [];
      while (i < messages.length && messages[i].role === 'tool') {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: messages[i].toolCallId!,
          content: messages[i].content ?? '',
        });
        i++;
      }
      out.push({ role: 'user', content: toolResults });
      continue;
    }

    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      const content: AnthropicContentBlock[] = [];
      if (msg.content) content.push({ type: 'text', text: msg.content });
      for (const tc of msg.toolCalls) {
        content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args });
      }
      out.push({ role: 'assistant', content });
      i++;
      continue;
    }

    out.push({ role: msg.role as 'user' | 'assistant', content: msg.content ?? '' });
    i++;
  }

  return { system, messages: out };
}

function toAnthropicTools(tools: ToolDefinition[]) {
  return tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}

function parseAnthropicResponse(body: Record<string, unknown>): LLMResponse {
  const content = body.content as AnthropicContentBlock[];
  const stopReason = body.stop_reason as string;
  const usage = body.usage as { input_tokens?: number; output_tokens?: number } | undefined;

  let textContent: string | null = null;
  const toolCalls: ToolCall[] = [];

  for (const block of content) {
    if (block.type === 'text' && block.text) textContent = block.text;
    if (block.type === 'tool_use' && block.id && block.name) {
      toolCalls.push({ id: block.id, name: block.name, args: block.input ?? {} });
    }
  }

  const tokensUsed = usage ? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) : undefined;

  return {
    content: textContent,
    toolCalls,
    finishReason: stopReason === 'tool_use' ? 'tool_calls'
      : stopReason === 'max_tokens' ? 'length'
      : 'stop',
    tokensUsed,
  };
}

// ---- Mock LLM handler -------------------------------------------------------

let mockCallCount = 0;

function callMockLLM(config: MockLLMConfig, messages: InternalMessage[]): LLMResponse {
  if (config.handler) {
    return config.handler(messages);
  }

  // If toolCalls defined and we haven't sent them yet (check history for tool results)
  const hasToolResults = messages.some(m => m.role === 'tool');

  if (config.toolCalls && !hasToolResults) {
    mockCallCount++;
    return {
      content: null,
      toolCalls: config.toolCalls.map((tc, i) => ({
        id: `mock-call-${mockCallCount}-${i}`,
        name: tc.name,
        args: tc.args,
      })),
      finishReason: 'tool_calls',
    };
  }

  const response = config.afterToolCalls ?? config.response ?? 'Mock LLM response.';
  return { content: response, toolCalls: [], finishReason: 'stop' };
}

// ---- Main callLLM -----------------------------------------------------------

export async function callLLM(
  config: LLMConfig,
  messages: InternalMessage[],
  tools: ToolDefinition[],
  signal?: AbortSignal,
): Promise<LLMResponse> {
  if (isMockLLM(config)) {
    return callMockLLM(config, messages);
  }

  const provider = detectProvider(config);

  if (provider === 'anthropic') {
    return callAnthropic(config, messages, tools, signal);
  }
  return callOpenAICompat(config, messages, tools, signal);
}

// ---- callLLMStream (text only, no tool calls in stream) --------------------

export async function* callLLMStream(
  config: LLMConfig,
  messages: InternalMessage[],
  signal?: AbortSignal,
): AsyncGenerator<string> {
  if (isMockLLM(config)) {
    const response = config.response ?? config.afterToolCalls ?? 'Mock LLM response.';
    yield response;
    return;
  }

  const provider = detectProvider(config as RealLLMConfig);

  if (provider === 'anthropic') {
    yield* streamAnthropic(config as RealLLMConfig, messages, signal);
  } else {
    yield* streamOpenAICompat(config as RealLLMConfig, messages, signal);
  }
}

// ---- OpenAI-compat fetch ---------------------------------------------------

async function callOpenAICompat(
  config: RealLLMConfig,
  messages: InternalMessage[],
  tools: ToolDefinition[],
  signal?: AbortSignal,
): Promise<LLMResponse> {
  const url = `${config.url.replace(/\/$/, '')}/chat/completions`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;

  const body: Record<string, unknown> = {
    model: config.model,
    messages: toOpenAIMessages(messages),
  };
  if (tools.length > 0) {
    body.tools = toOpenAITools(tools);
    body.tool_choice = 'auto';
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw new Error(`[NirnamAgent] LLM request failed (${response.status}): ${text}`);
  }

  return parseOpenAIResponse(await response.json() as Record<string, unknown>);
}

async function* streamOpenAICompat(
  config: RealLLMConfig,
  messages: InternalMessage[],
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const url = `${config.url.replace(/\/$/, '')}/chat/completions`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: config.model, messages: toOpenAIMessages(messages), stream: true }),
    signal,
  });

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => response.statusText);
    throw new Error(`[NirnamAgent] LLM stream failed (${response.status}): ${text}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') return;
        try {
          const parsed = JSON.parse(data) as {
            choices: Array<{ delta: { content?: string }; finish_reason?: string }>;
          };
          const chunk = parsed.choices?.[0]?.delta?.content;
          if (chunk) yield chunk;
        } catch { /* ignore malformed SSE lines */ }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ---- Anthropic fetch -------------------------------------------------------

async function callAnthropic(
  config: RealLLMConfig,
  messages: InternalMessage[],
  tools: ToolDefinition[],
  signal?: AbortSignal,
): Promise<LLMResponse> {
  const url = config.url.includes('/v1/messages')
    ? config.url
    : `${config.url.replace(/\/$/, '')}/v1/messages`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
  };
  if (config.apiKey) headers['x-api-key'] = config.apiKey;

  const { system, messages: anthropicMessages } = toAnthropicMessages(messages);
  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: 4096,
    messages: anthropicMessages,
  };
  if (system) body.system = system;
  if (tools.length > 0) body.tools = toAnthropicTools(tools);

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw new Error(`[NirnamAgent] Anthropic request failed (${response.status}): ${text}`);
  }

  return parseAnthropicResponse(await response.json() as Record<string, unknown>);
}

async function* streamAnthropic(
  config: RealLLMConfig,
  messages: InternalMessage[],
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const url = config.url.includes('/v1/messages')
    ? config.url
    : `${config.url.replace(/\/$/, '')}/v1/messages`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
  };
  if (config.apiKey) headers['x-api-key'] = config.apiKey;

  const { system, messages: anthropicMessages } = toAnthropicMessages(messages);
  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: 4096,
    messages: anthropicMessages,
    stream: true,
  };
  if (system) body.system = system;

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => response.statusText);
    throw new Error(`[NirnamAgent] Anthropic stream failed (${response.status}): ${text}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        try {
          const parsed = JSON.parse(data) as {
            type: string;
            delta?: { type?: string; text?: string };
          };
          if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
            const chunk = parsed.delta.text;
            if (chunk) yield chunk;
          }
          if (parsed.type === 'message_stop') return;
        } catch { /* ignore malformed SSE lines */ }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
