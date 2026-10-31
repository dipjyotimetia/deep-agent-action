import { AIMessage } from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";

/** One scripted model turn: receives the tools bound for this call. */
export type ScriptStep = (boundTools: string[]) => AIMessage;

/**
 * A chat model that plays back a fixed script across every call in a run, main
 * agent and subagents alike, and records which tools each call could see. It lets
 * tests drive the real deepagents graph with no network.
 */
export class ScriptedModel extends BaseChatModel {
  /** Tools visible to each model call, in order. */
  readonly seenTools: string[][] = [];
  /** Full message text sent to each model call, in order. */
  readonly seenPrompts: string[] = [];
  private cursor = 0;
  private bound: string[] = [];
  private shared: ScriptedModel = this;

  constructor(
    private readonly script: ScriptStep[],
    private readonly usage = { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
  ) {
    super({});
  }

  _llmType(): string {
    return "scripted";
  }

  override bindTools(tools: unknown[]): any {
    const next = new ScriptedModel(this.script, this.usage);
    next.shared = this.shared;
    next.bound = tools
      .map((tool) => {
        const t = tool as { name?: string; function?: { name?: string } };
        return t.name ?? t.function?.name ?? "";
      })
      .filter(Boolean);
    return next;
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const owner = this.shared;
    owner.seenTools.push(this.bound);
    owner.seenPrompts.push(messages.map((m) => JSON.stringify(m.content)).join("\n"));
    const step = owner.script[owner.cursor++];
    const message = step ? step(this.bound) : new AIMessage("done");
    message.usage_metadata = this.usage;
    return { generations: [{ text: "", message }] };
  }
}

/** An AI message making a single tool call. */
export function toolCall(name: string, args: Record<string, unknown>, id: string): AIMessage {
  return new AIMessage({ content: "", tool_calls: [{ name, args, id, type: "tool_call" }] });
}
