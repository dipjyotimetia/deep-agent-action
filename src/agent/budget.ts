import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { LLMResult } from "@langchain/core/outputs";
import type { Serialized } from "@langchain/core/load/serializable";
import type { BaseMessage } from "@langchain/core/messages";
import type { TokenUsage } from "../types.js";
import { evaluateSpend, priceUsd, roundUsd, type BudgetLimits } from "./cost.js";

/**
 * Pull token usage out of one LLM result. Prefers the modern `usage_metadata`
 * on the generation message (what every provider the action supports reports),
 * falling back to the older `llmOutput.tokenUsage` shape. Providers that report
 * neither contribute zero — the same blind spot the post-run cost estimate has.
 */
export function usageFromLLMResult(output: LLMResult): TokenUsage {
  let input = 0;
  let out = 0;
  for (const generation of output.generations ?? []) {
    for (const g of generation) {
      const msg = (g as { message?: { usage_metadata?: unknown } }).message;
      const um = msg?.usage_metadata as
        { input_tokens?: number; output_tokens?: number } | undefined;
      if (um) {
        input += um.input_tokens ?? 0;
        out += um.output_tokens ?? 0;
      }
    }
  }
  if (input === 0 && out === 0 && output.llmOutput) {
    const tu = (output.llmOutput.tokenUsage ?? output.llmOutput.usage) as
      | {
          promptTokens?: number;
          completionTokens?: number;
          prompt_tokens?: number;
          completion_tokens?: number;
          input_tokens?: number;
          output_tokens?: number;
        }
      | undefined;
    if (tu) {
      input += tu.promptTokens ?? tu.prompt_tokens ?? tu.input_tokens ?? 0;
      out += tu.completionTokens ?? tu.completion_tokens ?? tu.output_tokens ?? 0;
    }
  }
  return { input, output: out };
}

/** The model that served a result, as reported on the response itself. */
function modelFromResult(output: LLMResult): string | undefined {
  const message = (
    output.generations?.[0]?.[0] as
      { message?: { response_metadata?: Record<string, unknown> } } | undefined
  )?.message;
  const name = message?.response_metadata?.model_name ?? message?.response_metadata?.model;
  return typeof name === "string" && name ? name : undefined;
}

/**
 * A callback handler that meters cumulative token spend across every model call
 * — the main agent AND its subagents — and aborts the run the instant a budget
 * ceiling is crossed. With no limits it only meters, so reporting covers subagent
 * spend whether or not a budget is set.
 *
 * The meter must be a callback, not a stream-loop check: `deepagents` runs
 * subagents via an opaque `subagent.invoke(...)` that returns only a single
 * ToolMessage to the parent, so subagent token usage never appears in the
 * parent's streamed messages. A message-summing cap would silently undercount
 * (fail open). Since the subagent invoke spreads the parent run config, this
 * handler's `handleLLMEnd` fires for subagent calls too, and aborting via the
 * shared AbortController interrupts even mid-subagent.
 *
 * Each call is priced by the model that served it, since a specialist subagent
 * may use a different model from the main agent.
 */
export class BudgetMeter extends BaseCallbackHandler {
  name = "BudgetMeter";
  readonly total: TokenUsage = { input: 0, output: 0 };
  /** Set to "budget" once a ceiling is crossed and the run is aborted. */
  stopped: "budget" | undefined;
  reason: string | undefined;
  /** USD spent on calls with a known price. */
  private spentUsd = 0;
  /** True once any call used a model with no known price. */
  private hasUnpriced = false;
  private readonly modelByRun = new Map<string, string>();

  constructor(
    private readonly model: string,
    private readonly limits: BudgetLimits,
    private readonly controller: AbortController,
  ) {
    super();
  }

  /** Estimated run cost, or undefined when any metered call could not be priced. */
  get costUsd(): number | undefined {
    if (this.hasUnpriced || this.total.input + this.total.output === 0) return undefined;
    return roundUsd(this.spentUsd);
  }

  handleChatModelStart(
    _llm: Serialized,
    _messages: BaseMessage[][],
    runId: string,
    _parentRunId?: string,
    _extraParams?: Record<string, unknown>,
    _tags?: string[],
    metadata?: Record<string, unknown>,
  ): void {
    const name = metadata?.ls_model_name;
    if (typeof name === "string" && name) this.modelByRun.set(runId, name);
  }

  handleLLMEnd(output: LLMResult, runId?: string): void {
    const usage = usageFromLLMResult(output);
    this.total.input += usage.input;
    this.total.output += usage.output;

    const served = (runId ? this.modelByRun.get(runId) : undefined) ?? modelFromResult(output);
    if (runId) this.modelByRun.delete(runId);
    if (usage.input + usage.output > 0) {
      // Prefer the served name only when it has a price: adapters can report
      // deployment names that say nothing about the underlying model.
      const usd = (served ? priceUsd(served, usage) : undefined) ?? priceUsd(this.model, usage);
      if (usd === undefined) this.hasUnpriced = true;
      else this.spentUsd += usd;
    }

    if (this.stopped) return;
    // Partial pricing still binds the cost cap: known spend is a lower bound.
    const verdict = evaluateSpend(
      this.spentUsd > 0 ? roundUsd(this.spentUsd) : undefined,
      this.total,
      this.limits,
    );
    if (verdict.exceeded) {
      this.stopped = "budget";
      this.reason = verdict.reason;
      this.controller.abort();
    }
  }
}
