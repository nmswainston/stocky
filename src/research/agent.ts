import Anthropic from '@anthropic-ai/sdk';
import type { UsageLike } from './cost.js';
import { SYSTEM_PROMPT, THESIS_SCHEMA } from './prompt.js';

// The one place that talks to Claude. It gets text in and JSON out and
// has no tools, so the model cannot browse, call a broker or run code.
// A small interface sits in front of the SDK so tests run offline.

export interface ThesisReply {
  json: unknown;
  usage: UsageLike;
  stopReason: string | null;
}

export interface ThesisWriter {
  // model overrides the writer's default for this one call, so budget
  // routing can mix models inside a single run.
  write(userPrompt: string, model?: string): Promise<ThesisReply>;
}

export function claudeThesisWriter(options: {
  apiKey: string;
  model: string;
  effort: 'low' | 'medium' | 'high';
  maxOutputTokens: number;
}): ThesisWriter {
  const client = new Anthropic({ apiKey: options.apiKey, maxRetries: 3 });
  return {
    async write(userPrompt, model) {
      const response = await client.messages.create({
        model: model ?? options.model,
        max_tokens: options.maxOutputTokens,
        system: SYSTEM_PROMPT,
        output_config: {
          effort: options.effort,
          format: { type: 'json_schema', schema: THESIS_SCHEMA as unknown as Record<string, unknown> },
        },
        messages: [{ role: 'user', content: userPrompt }],
      });
      const text = response.content
        .filter((block) => block.type === 'text')
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('');
      let json: unknown = null;
      // A refusal or a max_tokens cut leaves no complete JSON; the
      // validator turns null into a zero-score, unverified thesis.
      if (response.stop_reason === 'end_turn') {
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
      }
      return { json, usage: response.usage, stopReason: response.stop_reason };
    },
  };
}
