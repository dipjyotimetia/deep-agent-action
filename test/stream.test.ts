import { describe, expect, test } from "bun:test";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { runAgentStream, type StreamActivity, type TodoItem } from "../src/agent/stream.js";

/** A fake agent whose stream yields the given "values"-mode state chunks. */
function fakeAgent(chunks: unknown[]) {
  return {
    stream: async function* () {
      for (const chunk of chunks) yield chunk;
    },
  };
}

const opts = { threadId: "t1", debounceMs: 0, recursionLimit: 150 };

describe("runAgentStream", () => {
  test("summary is the last AI message; tokens sum over AI messages", async () => {
    const messages = [
      new HumanMessage("do the thing"),
      new AIMessage({
        content: "working…",
        usage_metadata: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
      }),
      new AIMessage({
        content: "All done. Fixed it.",
        usage_metadata: { input_tokens: 7, output_tokens: 5, total_tokens: 12 },
      }),
    ];
    const result = await runAgentStream(fakeAgent([{ messages }]), {}, opts);

    expect(result.summary).toBe("All done. Fixed it.");
    expect(result.tokens).toEqual({ input: 17, output: 9 });
  });

  test("coerces array-of-parts message content to text", async () => {
    const messages = [
      new AIMessage({
        content: [
          { type: "text", text: "Part A" },
          { type: "text", text: " Part B" },
        ],
      }),
    ];
    const result = await runAgentStream(fakeAgent([{ messages }]), {}, opts);
    expect(result.summary).toBe("Part A Part B");
  });

  test("filters non-BaseMessage entries (graceful, never crashes)", async () => {
    const messages = [
      { role: "ai", content: "ghost (not a BaseMessage instance)" },
      new AIMessage("real summary"),
    ];
    const result = await runAgentStream(fakeAgent([{ messages }]), {}, opts);
    expect(result.summary).toBe("real summary");
  });

  test("mirrors the latest todos plan and reports it on progress", async () => {
    const seen: TodoItem[][] = [];
    const chunks = [
      { todos: [{ content: "step 1", status: "in_progress" }], messages: [] },
      { todos: [{ content: "step 1", status: "completed" }], messages: [new AIMessage("ok")] },
    ];
    const result = await runAgentStream(
      fakeAgent(chunks),
      {},
      {
        ...opts,
        onProgress: (todos) => {
          seen.push(todos);
        },
      },
    );

    expect(result.todos).toEqual([{ content: "step 1", status: "completed" }]);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.at(-1)).toEqual([{ content: "step 1", status: "completed" }]);
  });

  test("reports typed tool activity without duplicating streamed state", async () => {
    const seen: StreamActivity[] = [];
    const messages = [
      new AIMessage({
        content: "",
        tool_calls: [
          { name: "search_web", args: { query: "deepagents" }, id: "call-1" },
          { name: "search_web", args: { query: "langgraph" }, id: "call-2" },
        ],
      }),
      new ToolMessage({
        content: "found it",
        name: "search_web",
        tool_call_id: "call-1",
      }),
      new ToolMessage({
        content: "found that too",
        name: "search_web",
        tool_call_id: "call-2",
      }),
    ];
    const result = await runAgentStream(
      fakeAgent([{ messages: [messages[0]] }, { messages }, { messages }]),
      {},
      {
        ...opts,
        onActivity: (activity) => {
          seen.push(activity);
        },
      },
    );

    expect(seen).toEqual([
      { type: "tool_call", name: "search_web", namespace: [], id: "call-1" },
      { type: "tool_call", name: "search_web", namespace: [], id: "call-2" },
      { type: "tool_result", name: "search_web", namespace: [], id: "call-1" },
      { type: "tool_result", name: "search_web", namespace: [], id: "call-2" },
    ]);
    expect(result.activities).toEqual(seen);
  });

  const budget = { model: "anthropic:claude-sonnet-4-6", maxTotalTokens: 200 };
  const llmEnd = (input: number, output: number) => ({
    generations: [
      [{ text: "", message: { usage_metadata: { input_tokens: input, output_tokens: output } } }],
    ],
  });

  test("budget: a meter breach aborts and reports stopped + the meter's tokens", async () => {
    // The fake stream drives the injected meter past the cap, then throws — as a
    // real cancelled LangGraph run would.
    const agent = {
      stream: async function* (_input: unknown, config: any) {
        const meter = config.callbacks[0];
        yield {
          todos: [{ content: "work", status: "in_progress" }],
          messages: [new AIMessage("…")],
        };
        meter.handleLLMEnd(llmEnd(300, 0)); // crosses the 200 cap → aborts
        throw new Error("Aborted"); // shape is irrelevant; meter.stopped drives the catch
      },
    };
    const result = await runAgentStream(agent, {}, { ...opts, budget });
    expect(result.stopped).toBe("budget");
    expect(result.tokens).toEqual({ input: 300, output: 0 });
  });

  test("budget: under the cap, completes normally with the meter's tokens", async () => {
    const agent = {
      stream: async function* (_input: unknown, config: any) {
        const meter = config.callbacks[0];
        meter.handleLLMEnd(llmEnd(50, 10));
        yield { messages: [new AIMessage("done")] };
      },
    };
    const result = await runAgentStream(agent, {}, { ...opts, budget });
    expect(result.stopped).toBeUndefined();
    expect(result.tokens).toEqual({ input: 50, output: 10 });
    expect(result.summary).toBe("done");
  });

  test("no budget: a real error still propagates (catch only swallows budget aborts)", async () => {
    const agent = {
      stream: async function* () {
        yield { messages: [] };
        throw new Error("boom");
      },
    };
    await expect(runAgentStream(agent, {}, opts)).rejects.toThrow("boom");
  });

  test("timeout: an expired runtime cap aborts and reports stopped='timeout'", async () => {
    // The fake stream waits for the timer's abort signal, then throws — as a
    // real cancelled LangGraph run would. No budget is configured, so the
    // catch must key on the timeout, not the meter.
    const agent = {
      stream: async function* (_input: unknown, config: any) {
        yield { messages: [new AIMessage("partial")] };
        await new Promise<void>((resolve) => {
          if (config.signal.aborted) return resolve();
          config.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new Error("Aborted");
      },
    };
    const result = await runAgentStream(agent, {}, { ...opts, maxRuntimeMs: 10 });
    expect(result.stopped).toBe("timeout");
    expect(result.summary).toBe("partial");
  });

  test("timeout: an unexpired cap leaves the run untouched and real errors propagate", async () => {
    const ok = fakeAgent([{ messages: [new AIMessage("done")] }]);
    const result = await runAgentStream(ok, {}, { ...opts, maxRuntimeMs: 60_000 });
    expect(result.stopped).toBeUndefined();
    expect(result.summary).toBe("done");

    const failing = {
      stream: async function* () {
        yield { messages: [] };
        throw new Error("boom");
      },
    };
    await expect(runAgentStream(failing, {}, { ...opts, maxRuntimeMs: 60_000 })).rejects.toThrow(
      "boom",
    );
  });

  test("stalls when an identical tool call repeats without todo progress", async () => {
    const repeatedCall = (id: string) =>
      new AIMessage({
        content: "",
        tool_calls: [{ name: "read_file", args: { path: "/src/index.ts" }, id }],
      });
    const result = await runAgentStream(
      fakeAgent([
        { todos: [{ content: "inspect", status: "in_progress" }], messages: [repeatedCall("1")] },
        { todos: [{ content: "inspect", status: "in_progress" }], messages: [repeatedCall("2")] },
        { todos: [{ content: "inspect", status: "in_progress" }], messages: [repeatedCall("3")] },
      ]),
      {},
      { ...opts, maxRepeatedToolCalls: 3 },
    );

    expect(result.stopped).toBe("stalled");
    expect(result.stopDetail).toContain("read_file");
  });

  test("keeps a detected stalled stop when stream cleanup reports cancellation", async () => {
    const repeatedCall = (id: string) =>
      new AIMessage({
        content: "",
        tool_calls: [{ name: "read_file", args: { path: "/src/index.ts" }, id }],
      });
    const agent = {
      stream: async function* () {
        try {
          yield {
            todos: [{ content: "inspect", status: "in_progress" }],
            messages: [repeatedCall("1")],
          };
          yield {
            todos: [{ content: "inspect", status: "in_progress" }],
            messages: [repeatedCall("2")],
          };
        } finally {
          throw new Error("Aborted");
        }
      },
    };

    const result = await runAgentStream(agent, {}, { ...opts, maxRepeatedToolCalls: 2 });
    expect(result.stopped).toBe("stalled");
  });

  test("resets repeated-call tracking when the main todo plan progresses", async () => {
    const call = (id: string) =>
      new AIMessage({
        content: "",
        tool_calls: [{ name: "read_file", args: { path: "/src/index.ts" }, id }],
      });
    const result = await runAgentStream(
      fakeAgent([
        { todos: [{ content: "inspect", status: "in_progress" }], messages: [call("1")] },
        { todos: [{ content: "inspect", status: "in_progress" }], messages: [call("2")] },
        { todos: [{ content: "inspect", status: "completed" }], messages: [call("3")] },
      ]),
      {},
      { ...opts, maxRepeatedToolCalls: 3 },
    );

    expect(result.stopped).toBeUndefined();
  });

  test("a file edit resets repeated-call tracking without any todo change", async () => {
    const run = (id: string) =>
      new AIMessage({
        content: "",
        tool_calls: [{ name: "execute", args: { command: "npm test" }, id }],
      });
    const edit = (id: string) =>
      new AIMessage({
        content: "",
        tool_calls: [{ name: "edit_file", args: { file_path: `/${id}`, old_string: "a" }, id }],
      });
    const result = await runAgentStream(
      fakeAgent([
        { messages: [run("r1"), run("r2")] },
        { messages: [run("r1"), run("r2"), edit("e1")] },
        { messages: [run("r1"), run("r2"), edit("e1"), run("r3"), run("r4")] },
      ]),
      {},
      { ...opts, maxRepeatedToolCalls: 3 },
    );
    expect(result.stopped).toBeUndefined();
  });

  test("the same edit repeating still stalls", async () => {
    const edit = (id: string) =>
      new AIMessage({
        content: "",
        tool_calls: [{ name: "edit_file", args: { file_path: "/a", old_string: "a" }, id }],
      });
    const result = await runAgentStream(
      fakeAgent([{ messages: [edit("1"), edit("2"), edit("3")] }]),
      {},
      { ...opts, maxRepeatedToolCalls: 3 },
    );
    expect(result.stopped).toBe("stalled");
  });

  test("surfaces the main agent's structured response but not a subagent's", async () => {
    const result = await runAgentStream(
      fakeAgent([
        [["subagent"], { messages: [], structuredResponse: { from: "subagent" } }],
        { messages: [], structuredResponse: { from: "main" } },
      ]),
      {},
      opts,
    );
    expect(result.structuredResponse).toEqual({ from: "main" });
  });

  test("meters usage and cost with no budget configured", async () => {
    const agent = {
      stream: async function* (_input: unknown, config: any) {
        config.callbacks[0].handleLLMEnd(llmEnd(1_000_000, 0));
        yield { messages: [new AIMessage("done")] };
      },
    };
    const result = await runAgentStream(
      agent,
      {},
      {
        ...opts,
        budget: { model: "anthropic:claude-sonnet-4-6" },
      },
    );
    expect(result.tokens).toEqual({ input: 1_000_000, output: 0 });
    expect(result.costUsd).toBe(3);
    expect(result.stopped).toBeUndefined();
  });

  test("does not collide repeated calls with different arguments or namespaces", async () => {
    const rootRead = new AIMessage({
      content: "",
      tool_calls: [{ name: "read_file", args: { path: "/src/a.ts" }, id: "root-1" }],
    });
    const otherRead = new AIMessage({
      content: "",
      tool_calls: [{ name: "read_file", args: { path: "/src/b.ts" }, id: "root-2" }],
    });
    const subagentRead = new AIMessage({
      content: "",
      tool_calls: [{ name: "read_file", args: { path: "/src/a.ts" }, id: "subagent-1" }],
    });
    const result = await runAgentStream(
      fakeAgent([
        { todos: [{ content: "inspect", status: "in_progress" }], messages: [rootRead] },
        { todos: [{ content: "inspect", status: "in_progress" }], messages: [otherRead] },
        [["subagent"], { messages: [subagentRead] }],
      ]),
      {},
      { ...opts, maxRepeatedToolCalls: 2 },
    );

    expect(result.stopped).toBeUndefined();
  });

  test("turns a recursion-ceiling error into a recoverable stalled stop", async () => {
    const agent = {
      stream: async function* () {
        yield {
          todos: [{ content: "partial work", status: "in_progress" }],
          messages: [new AIMessage("Still working")],
        };
        throw new Error("Recursion limit of 150 reached without hitting a stop condition.");
      },
    };

    const result = await runAgentStream(agent, {}, opts);
    expect(result.stopped).toBe("stalled");
    expect(result.stopDetail).toContain("recursion ceiling");
    expect(result.todos).toEqual([{ content: "partial work", status: "in_progress" }]);
  });

  test("recursionLimit: passed through to the stream config", async () => {
    const seen: number[] = [];
    const agent = {
      stream: async function* (_input: unknown, config: any) {
        seen.push(config.recursionLimit);
        yield { messages: [] };
      },
    };
    await runAgentStream(agent, {}, opts);
    await runAgentStream(agent, {}, { ...opts, recursionLimit: 400 });
    expect(seen).toEqual([150, 400]);
  });
});
