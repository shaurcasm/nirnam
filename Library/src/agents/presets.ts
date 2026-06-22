import type { AgentConfig, LLMConfig } from './types';

type PartialAgentConfig = Omit<AgentConfig, 'llm'>;

export const presets = {
  /**
   * Filesystem agent: full read/write access after folder grant.
   * Tools (read_file, write_file, etc.) are added automatically once mountFolder is called.
   */
  filesystem(options: { mode?: 'read' | 'readwrite'; systemPrompt?: string } = {}): PartialAgentConfig {
    return {
      systemPrompt: options.systemPrompt ??
        'You are a file system assistant. You can read and write files in the folder the user has granted access to. ' +
        'Always prefer reading existing files before making changes. ' +
        'When asked to modify a file, show the user what you plan to change before writing.',
      filesystem: { mode: options.mode ?? 'readwrite', lazy: true },
    };
  },

  /**
   * Code review agent: read-only filesystem + code-focused system prompt.
   */
  codeReview(options: { systemPrompt?: string } = {}): PartialAgentConfig {
    return {
      systemPrompt: options.systemPrompt ??
        'You are a senior software engineer performing a code review. ' +
        'Analyse the code for correctness bugs, security issues, performance problems, and style consistency. ' +
        'Be concise and cite specific line numbers when possible. Prioritise actionable findings.',
      filesystem: { mode: 'read', lazy: true },
    };
  },

  /**
   * Summarizer agent: condensed, neutral summaries.
   */
  summarizer(options: { systemPrompt?: string } = {}): PartialAgentConfig {
    return {
      systemPrompt: options.systemPrompt ??
        'You summarise text clearly and concisely. ' +
        'Preserve key facts, numbers, and proper nouns. ' +
        'Respond with only the summary — no preamble.',
    };
  },

  /**
   * Monitor agent (passive mode): classifies and analyses incoming data.
   */
  monitor(options: { systemPrompt?: string } = {}): PartialAgentConfig {
    return {
      mode: 'passive' as const,
      systemPrompt: options.systemPrompt ??
        'You monitor and classify incoming data events. ' +
        'Respond in JSON with keys: { severity, category, message, suggestion }. ' +
        'severity is one of: info, warn, error, critical.',
    };
  },
} as const;

/**
 * Merge a preset with a full AgentConfig.
 * The llm field is always required — presets never include it.
 *
 * @example
 * const agent = createAgent(withPreset(presets.filesystem(), { llm: { url: '...', model: '...' } }));
 */
export function withPreset(
  preset: PartialAgentConfig,
  config: { llm: LLMConfig } & Partial<AgentConfig>,
): AgentConfig {
  return { ...preset, ...config };
}
