import type { TokenUsage } from "../types.js";

/** Rough USD price per 1M tokens, matched by model-name substring. Estimates only. */
const PRICES: ReadonlyArray<{ match: RegExp; inPerM: number; outPerM: number }> = [
  { match: /claude.*opus/i, inPerM: 15, outPerM: 75 },
  { match: /claude.*sonnet/i, inPerM: 3, outPerM: 15 },
  { match: /claude.*haiku/i, inPerM: 1, outPerM: 5 },
  { match: /gpt.*mini|o\d.*mini/i, inPerM: 0.6, outPerM: 2.4 },
  { match: /gpt|o\d/i, inPerM: 2.5, outPerM: 10 },
  { match: /gemini.*flash/i, inPerM: 0.3, outPerM: 2.5 },
  { match: /gemini/i, inPerM: 1.25, outPerM: 10 },
];

/** Unrounded USD price of some token usage, or undefined for unknown models. */
export function priceUsd(model: string, tokens: TokenUsage): number | undefined {
  const price = PRICES.find((p) => p.match.test(model));
  if (!price) return undefined;
  return (tokens.input / 1_000_000) * price.inPerM + (tokens.output / 1_000_000) * price.outPerM;
}

/** Round a USD amount for reporting. */
export function roundUsd(usd: number): number {
  return Math.round(usd * 10_000) / 10_000;
}

/**
 * Estimate run cost in USD from token usage, matched by model name.
 * Returns undefined for unknown models (caller reports tokens only).
 */
export function estimateCostUsd(model: string, tokens: TokenUsage): number | undefined {
  const usd = priceUsd(model, tokens);
  return usd === undefined ? undefined : roundUsd(usd);
}

/** Optional ceilings for a run; either, both, or neither may be set. */
export interface BudgetLimits {
  /** Stop once estimated spend reaches this many USD (needs a known model price). */
  maxCostUsd?: number;
  /** Stop once cumulative billed tokens (input + output) reach this many. */
  maxTotalTokens?: number;
}

export interface BudgetVerdict {
  exceeded: boolean;
  reason?: string;
}

/**
 * Decide whether accumulated usage has crossed a configured ceiling. Pure.
 *
 * The token cap always applies. The cost cap only applies when the model has a
 * known price (`estimateCostUsd` returns a number) — an unpriced model can't be
 * cost-capped, so callers should pair `maxCostUsd` with `maxTotalTokens` for
 * those. Returns `{ exceeded: false }` when neither limit is set.
 */
export function evaluateBudget(
  model: string,
  tokens: TokenUsage,
  limits: BudgetLimits,
): BudgetVerdict {
  return evaluateSpend(estimateCostUsd(model, tokens), tokens, limits);
}

/** `evaluateBudget` for an already-computed cost, e.g. one summed across models. */
export function evaluateSpend(
  costUsd: number | undefined,
  tokens: TokenUsage,
  limits: BudgetLimits,
): BudgetVerdict {
  const total = tokens.input + tokens.output;
  if (limits.maxTotalTokens != null && total >= limits.maxTotalTokens) {
    return { exceeded: true, reason: `token budget reached (${total} ≥ ${limits.maxTotalTokens})` };
  }
  if (limits.maxCostUsd != null && costUsd != null && costUsd >= limits.maxCostUsd) {
    return {
      exceeded: true,
      reason: `cost budget reached (~$${costUsd.toFixed(4)} ≥ $${limits.maxCostUsd})`,
    };
  }
  return { exceeded: false };
}
