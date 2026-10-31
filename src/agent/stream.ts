import { isAIMessage, isBaseMessage } from "@langchain/core/messages";
import type { BaseMessage, MessageContent } from "@langchain/core/messages";
import type { StopReason, TokenUsage } from "../types.js";
import { BudgetMeter } from "./budget.js";
import type { BudgetLimits } from "./cost.js";

export interface TodoItem {
  content: string;
  status: string;
}

export interface StreamResult {
  todos: TodoItem[];
  summary: string;
  tokens: TokenUsage;
  /** Set when the run was aborted early by a budget, runtime, or loop ceiling. */
  stopped?: StopReason;
  /** Safe, human-readable explanation for a deliberate stalled stop. */
  stopDetail?: string;
  /** Deduplicated tool activity observed across main and subagent streams. */
  activities: StreamActivity[];
  /** Estimated spend across all models, when every metered call could be priced. */
  costUsd?: number;
  /** The main agent's `responseFormat` result, when one was configured and produced. */
  structuredResponse?: unknown;
}

export interface StreamActivity {
  type: "tool_call" | "tool_result";
  name: string;
  namespace: string[];
  /** Provider/tool-call id used to distinguish repeated calls in one namespace. */
  id?: string;
}

/** Budget ceiling for a run, plus the model used to price tokens. */
export interface BudgetOptions extends BudgetLimits {
  model: string;
}

/** Coerce LangChain message content (string | array of parts) to plain text. */
function contentToString(content: MessageContent): string {
  if (typeof content === "string") return content;
  return content
    .map((part) =>
      typeof part !== "string" && "text" in part && typeof part.text === "string" ? part.text : "",
    )
    .join("");
}

/** Normalize a streamed item into { namespace, state } regardless of tuple shape. */
function extractState(item: unknown): { namespace: unknown[]; state: unknown } {
  if (Array.isArray(item)) {
    const namespace = Array.isArray(item[0]) ? (item[0] as unknown[]) : [];
    return { namespace, state: item[item.length - 1] };
  }
  return { namespace: [], state: item };
}

function mapTodos(raw: unknown): TodoItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((t: unknown) => {
    const r = (t ?? {}) as { content?: unknown; status?: unknown };
    return {
      content: String(r.content ?? ""),
      status: String(r.status ?? "pending"),
    };
  });
}

function messageActivities(messages: BaseMessage[], namespace: string[]): StreamActivity[] {
  const activities: StreamActivity[] = [];
  for (const message of messages) {
    if (isAIMessage(message)) {
      for (const call of message.tool_calls ?? []) {
        if (typeof call.name === "string" && call.name) {
          activities.push({
            type: "tool_call",
            name: call.name,
            namespace,
            ...(typeof call.id === "string" && call.id ? { id: call.id } : {}),
          });
        }
      }
    } else if (message.getType() === "tool") {
      const name = typeof message.name === "string" ? message.name : "";
      if (name) {
        const toolCallId =
          "tool_call_id" in message && typeof message.tool_call_id === "string"
            ? message.tool_call_id
            : undefined;
        activities.push({
          type: "tool_result",
          name,
          namespace,
          ...(toolCallId ? { id: toolCallId } : {}),
        });
      }
    }
  }
  return activities;
}

/** Stable in-memory representation for comparing model-provided tool arguments. */
function stableValue(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableValue(record[key])}`)
    .join(",")}}`;
}

function toolCallFingerprints(
  messages: BaseMessage[],
  namespace: string[],
): Array<{ callKey: string; key: string; name: string }> {
  const fingerprints: Array<{ callKey: string; key: string; name: string }> = [];
  for (const message of messages) {
    if (!isAIMessage(message)) continue;
    for (const call of message.tool_calls ?? []) {
      if (typeof call.name !== "string" || !call.name) continue;
      const callKey = `${namespace.join("/")}:${typeof call.id === "string" ? call.id : call.name}`;
      fingerprints.push({
        callKey,
        key: `${namespace.join("/")}:${call.name}:${stableValue(call.args)}`,
        name: call.name,
      });
    }
  }
  return fingerprints;
}

/**
 * Tools that change the repository: progress, so unchanged re-runs of a test
 * command between them are a normal fix loop rather than a stall.
 */
const MUTATING_TOOLS = new Set(["write_file", "edit_file", "delete"]);

function isRecursionLimitError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /recursion limit.*(?:reached|stop condition)/i.test(message);
}

/**
 * Drive the agent via streaming, mirroring plan/progress as it goes.
 *
 * Uses "values" mode so each chunk carries the full state (latest `todos` and
 * `messages`). Progress is mirrored through `onProgress`, debounced by
 * `debounceMs` and only when the plan changes; a final mirror always runs.
 */
export async function runAgentStream(
  // The DeepAgent harness types its stream input as a complex, version-specific
  // state type; `any` here keeps the call site assignable across versions. The
  // result is narrowed to an async iterable since we only `for await` over it.
  agent: {
    stream: (input: any, options?: any) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>;
  },
  input: unknown,
  options: {
    threadId: string;
    onProgress?: (todos: TodoItem[]) => Promise<void> | void;
    onActivity?: (activity: StreamActivity) => Promise<void> | void;
    debounceMs: number;
    /** When set, meter token spend and abort the run if a ceiling is crossed. */
    budget?: BudgetOptions;
    /** When set, abort the run once it has been streaming this long. */
    maxRuntimeMs?: number;
    /** Max agent super-steps per run (defaulted by `loadConfig`). */
    recursionLimit: number;
    /** Abort repeated identical tool calls that make no canonical todo progress. */
    maxRepeatedToolCalls?: number;
  },
): Promise<StreamResult> {
  let todos: TodoItem[] = [];
  let todosKey = "";
  let finalMessages: BaseMessage[] = [];
  let lastMirrorKey = "";
  let lastMirrorAt = 0;
  const activities: StreamActivity[] = [];
  const activityKeys = new Set<string>();
  const repeatedToolCallKeys = new Set<string>();
  const repeatedToolCallCounts = new Map<string, number>();
  let lastStagnationTodosKey = "";
  let stalled = false;
  let stopDetail: string | undefined;
  let structuredResponse: unknown;

  // Usage is always metered through a callback (which sees subagent calls too),
  // and enforces a budget cap when one is set; a runtime cap uses a timer. Both
  // abort through the same controller, whose signal propagates into subagent
  // invokes. (An un-aborted signal is inert.)
  const controller = new AbortController();
  const meter = new BudgetMeter(options.budget?.model ?? "", options.budget ?? {}, controller);
  let timedOut = false;
  const timer =
    options.maxRuntimeMs != null
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, options.maxRuntimeMs)
      : undefined;

  try {
    const stream = await agent.stream(input, {
      configurable: { thread_id: options.threadId },
      streamMode: "values",
      subgraphs: true,
      // A coding loop (read → edit → test → fix) can exceed the default
      // super-step ceiling, so the configured limit defaults well above it.
      recursionLimit: options.recursionLimit,
      signal: controller.signal,
      callbacks: [meter],
    });

    for await (const item of stream) {
      const { namespace, state } = extractState(item);
      if (!state || typeof state !== "object") continue;
      const s = state as { todos?: unknown; messages?: unknown; structuredResponse?: unknown };
      const stateMessages = Array.isArray(s.messages) ? s.messages.filter(isBaseMessage) : [];
      if (namespace.length === 0 && Array.isArray(s.todos)) {
        const nextTodos = mapTodos(s.todos);
        const nextTodosKey = JSON.stringify(nextTodos);
        if (nextTodosKey !== lastStagnationTodosKey) {
          repeatedToolCallCounts.clear();
          lastStagnationTodosKey = nextTodosKey;
        }
      }
      for (const fingerprint of toolCallFingerprints(stateMessages, namespace.map(String))) {
        if (repeatedToolCallKeys.has(fingerprint.callKey)) continue;
        repeatedToolCallKeys.add(fingerprint.callKey);
        const count = (repeatedToolCallCounts.get(fingerprint.key) ?? 0) + 1;
        // An edit resets every other call's count, but keeps its own, so the same
        // edit repeating forever still stalls.
        if (MUTATING_TOOLS.has(fingerprint.name)) repeatedToolCallCounts.clear();
        repeatedToolCallCounts.set(fingerprint.key, count);
        if (options.maxRepeatedToolCalls != null && count >= options.maxRepeatedToolCalls) {
          stalled = true;
          stopDetail = `Repeated tool call without todo progress: ${fingerprint.name} (${count} times).`;
          controller.abort();
          break;
        }
      }
      for (const activity of messageActivities(stateMessages, namespace.map(String))) {
        const key = `${activity.type}:${activity.namespace.join("/")}:${activity.id ?? activity.name}`;
        if (activityKeys.has(key)) continue;
        activityKeys.add(key);
        activities.push(activity);
        if (options.onActivity) await options.onActivity(activity);
      }

      if (stalled) break;

      // Only the main agent (empty namespace) drives the canonical plan/summary.
      if (namespace.length !== 0) continue;

      if (Array.isArray(s.todos)) {
        todos = mapTodos(s.todos);
        todosKey = JSON.stringify(todos); // re-keyed only when the plan changes
      }
      if (Array.isArray(s.messages)) finalMessages = s.messages.filter(isBaseMessage);
      if (s.structuredResponse !== undefined) structuredResponse = s.structuredResponse;

      if (options.onProgress) {
        const now = Date.now();
        if (todosKey !== lastMirrorKey && now - lastMirrorAt >= options.debounceMs) {
          lastMirrorKey = todosKey;
          lastMirrorAt = now;
          await options.onProgress(todos);
        }
      }
    }
  } catch (err) {
    // If the meter or the runtime timer deliberately aborted, whatever
    // cancellation error the stream produced is a clean early stop, not a
    // failure — swallow it regardless of its shape. Any other error propagates.
    if (!meter.stopped && !timedOut && !stalled && !isRecursionLimitError(err)) throw err;
    if (!meter.stopped && !timedOut && !stalled && isRecursionLimitError(err)) {
      stalled = true;
      stopDetail = "The agent reached its recursion ceiling without a stop condition.";
    }
  } finally {
    // Without this a pending timer keeps the process alive past the run (or
    // fires an abort after a successful completion).
    if (timer) clearTimeout(timer);
  }

  // Final mirror so the closing plan state is always reflected.
  if (options.onProgress && todosKey !== lastMirrorKey) {
    await options.onProgress(todos);
  }

  // Report the larger of the meter total (includes subagent spend) and the
  // message-summed total (covers providers that report usage on messages but
  // not via callbacks), so the callback path can never under-report.
  const summed = sumTokens(finalMessages);
  const tokens = {
    input: Math.max(meter.total.input, summed.input),
    output: Math.max(meter.total.output, summed.output),
  };
  const costUsd = meter.costUsd;
  return {
    todos,
    summary: lastAiText(finalMessages),
    tokens,
    stopped: meter.stopped ?? (timedOut ? "timeout" : stalled ? "stalled" : undefined),
    ...(stopDetail ? { stopDetail } : {}),
    activities,
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(structuredResponse !== undefined ? { structuredResponse } : {}),
  };
}

/** Sum input/output tokens across all AI messages in the final state. */
function sumTokens(messages: BaseMessage[]): TokenUsage {
  let input = 0;
  let output = 0;
  for (const msg of messages) {
    if (isAIMessage(msg) && msg.usage_metadata) {
      input += msg.usage_metadata.input_tokens ?? 0;
      output += msg.usage_metadata.output_tokens ?? 0;
    }
  }
  return { input, output };
}

/** The text of the last AI message in the final state (the agent's closing summary). */
function lastAiText(messages: BaseMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg && isAIMessage(msg)) {
      const text = contentToString(msg.content).trim();
      if (text) return text;
    }
  }
  return "";
}
