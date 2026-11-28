import { MODEL_PRICES } from './config.js';

// Dollar accounting for Claude calls, from the usage the API reports.

export interface UsageLike {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

function pricesFor(model: string) {
  const prices = MODEL_PRICES[model];
  if (!prices) throw new Error(`no price for model ${model}; add it to MODEL_PRICES in research/config.ts`);
  return prices;
}

export function costOf(model: string, usage: UsageLike): number {
  const prices = pricesFor(model);
  return (
    (usage.input_tokens * prices.input +
      usage.output_tokens * prices.output +
      (usage.cache_read_input_tokens ?? 0) * prices.cacheRead +
      (usage.cache_creation_input_tokens ?? 0) * prices.cacheWrite) /
    1_000_000
  );
}

// Rough token count for budgeting before a call: about 4 characters a
// token for English and JSON. Only used to decide whether to start.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export class Budget {
  spent = 0;

  // Every model that may bill against this budget is validated up
  // front, so an unknown price fails the run before any call is made.
  constructor(
    readonly limitUsd: number,
    private readonly model: string,
    extraModels: (string | null)[] = [],
  ) {
    pricesFor(model);
    for (const extra of extraModels) if (extra) pricesFor(extra);
  }

  // Worst case for the next call: the whole prompt plus every output
  // token we allow (thinking counts as output).
  worstCase(promptTokens: number, maxOutputTokens: number, model = this.model): number {
    return costOf(model, { input_tokens: promptTokens, output_tokens: maxOutputTokens });
  }

  canAfford(promptTokens: number, maxOutputTokens: number, model = this.model): boolean {
    return this.spent + this.worstCase(promptTokens, maxOutputTokens, model) <= this.limitUsd;
  }

  record(usage: UsageLike, model = this.model): number {
    const cost = costOf(model, usage);
    this.spent += cost;
    return cost;
  }
}
