/**
 * @palinc/nirnam/agents/testing
 *
 * Test utilities for NirnamAgent. Import only in test environments.
 *
 * @example
 * import { mockLLM } from '@palinc/nirnam/agents/testing';
 * import { createAgent } from '@palinc/nirnam/agents';
 *
 * const agent = createAgent({
 *   llm: mockLLM({ response: 'Hello from mock!' }),
 * });
 * const reply = await agent.chat('Hi');
 * assert(reply === 'Hello from mock!');
 */

import type { MockLLMConfig, InternalMessage, LLMResponse, ToolCall } from './agents/types';

export interface MockLLMOptions {
  /** Static text response returned after all tool calls (or directly if no toolCalls). */
  response?: string;
  /**
   * Tool calls the mock LLM will emit on the FIRST non-tool-result turn.
   * On subsequent turns (after tool results are in history), afterToolCalls is returned.
   */
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
  /** Response returned after tool results have been submitted. Defaults to `response`. */
  afterToolCalls?: string;
  /**
   * Fully custom handler. Receives the raw InternalMessage[] and must return an LLMResponse.
   * Overrides all other options when provided.
   */
  handler?: (messages: InternalMessage[]) => LLMResponse;
}

/**
 * Create a mock LLM config for use in tests.
 * Pass the result as the `llm` field of AgentConfig.
 */
export function mockLLM(options: MockLLMOptions = {}): MockLLMConfig {
  return { _isMock: true, ...options };
}

export interface ScenarioStep {
  /** Text the test will send to agent.chat() */
  userMessage: string;
  /** Expected reply from the agent */
  expectedReply: string;
  /** Optional tool calls the mock should emit during this turn */
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
  /** Tool results to return (keyed by tool name) */
  toolResults?: Record<string, string>;
}

/**
 * Create a stateful mock that walks through a scripted scenario step-by-step.
 * Each call to the handler advances one step in the scenario.
 */
export function scenarioMock(steps: ScenarioStep[]): MockLLMConfig {
  let step = 0;
  let awaitingToolResults = false;
  let callIdx = 0;

  const handler = (messages: InternalMessage[]): LLMResponse => {
    const current = steps[step];
    if (!current) {
      return { content: '(scenario complete)', toolCalls: [], finishReason: 'stop' };
    }

    const hasToolResults = messages.some(m => m.role === 'tool');

    if (!awaitingToolResults && current.toolCalls && current.toolCalls.length > 0) {
      awaitingToolResults = true;
      return {
        content: null,
        toolCalls: current.toolCalls.map((tc, i): ToolCall => ({
          id: `scenario-${step}-${callIdx++}-${i}`,
          name: tc.name,
          args: tc.args,
        })),
        finishReason: 'tool_calls',
      };
    }

    if (hasToolResults || !current.toolCalls?.length) {
      awaitingToolResults = false;
      const reply = current.expectedReply;
      step++;
      return { content: reply, toolCalls: [], finishReason: 'stop' };
    }

    return { content: current.expectedReply, toolCalls: [], finishReason: 'stop' };
  };

  return { _isMock: true, handler };
}
