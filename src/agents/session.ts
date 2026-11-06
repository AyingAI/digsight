import {
  createAgentSession,
  createExtensionRuntime,
  SessionManager,
  SettingsManager,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "../types.ts";
import { extractJson } from "../util.ts";
import type { RuntimeModel } from "../config.ts";

export interface AgentConfig {
  modelRuntime: ModelRuntime;
  model: RuntimeModel;
  modelLabel: string;
  thinkingLevel: ThinkingLevel;
  cwd: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Called with streamed assistant text (throttled by the caller if needed). */
  onText?: (delta: string) => void;
}

function minimalLoader(systemPrompt: string): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

export class EmptyAgentResponse extends Error {}

export class PiAgent {
  readonly modelLabel: string;
  #agent: Awaited<ReturnType<typeof createAgentSession>>["session"];
  #signal?: AbortSignal;
  #timeoutMs: number;
  #onText?: (delta: string) => void;
  #unsubscribe?: () => void;
  #disposed = false;

  private constructor(
    session: Awaited<ReturnType<typeof createAgentSession>>["session"],
    config: AgentConfig,
  ) {
    this.#agent = session;
    this.modelLabel = config.modelLabel;
    this.#signal = config.signal;
    this.#timeoutMs = config.timeoutMs ?? 6 * 60 * 1000;
    this.#onText = config.onText;
  }

  static async create(systemPrompt: string, config: AgentConfig): Promise<PiAgent> {
    const { session } = await createAgentSession({
      cwd: config.cwd,
      model: config.model,
      modelRuntime: config.modelRuntime,
      thinkingLevel: config.thinkingLevel,
      noTools: "all",
      tools: [],
      resourceLoader: minimalLoader(systemPrompt),
      sessionManager: SessionManager.inMemory(config.cwd),
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: "off", retry: { enabled: true, maxRetries: 2 } }),
    });
    const agent = new PiAgent(session, config);
    if (config.onText) {
      agent.#unsubscribe = session.subscribe((event) => {
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
          try {
            config.onText?.(event.assistantMessageEvent.delta);
          } catch {
            // streaming hooks are best-effort
          }
        }
      });
    }
    return agent;
  }

  async ask(prompt: string, timeoutMs?: number): Promise<string> {
    if (this.#disposed) throw new Error("agent already disposed");
    if (this.#signal?.aborted) throw new Error("cancelled");

    let timedOut = false;
    const limit = timeoutMs ?? this.#timeoutMs;
    const timer = setTimeout(() => {
      timedOut = true;
      void this.#agent.abort();
    }, limit);
    const onAbort = () => {
      void this.#agent.abort();
    };
    this.#signal?.addEventListener("abort", onAbort, { once: true });

    try {
      await this.#agent.prompt(prompt);
    } catch {
      if (this.#signal?.aborted) throw new Error("cancelled");
      if (timedOut) throw new Error(`model timed out after ${Math.round(limit / 1000)}s`);
      throw new Error("模型请求失败，请检查提供商的授权、额度与网络。");
    } finally {
      clearTimeout(timer);
      this.#signal?.removeEventListener("abort", onAbort);
    }

    if (this.#signal?.aborted) throw new Error("cancelled");
    if (timedOut) throw new Error(`model timed out after ${Math.round(limit / 1000)}s`);
    const text = this.#agent.getLastAssistantText() ?? "";
    if (!text.trim()) {
      if (timedOut) throw new Error(`model timed out after ${Math.round(limit / 1000)}s`);
      throw new EmptyAgentResponse("模型没有返回分析正文");
    }
    return text;
  }

  async structured<T>(
    prompt: string,
    options: { retries?: number; validate?: (value: T) => void; onRetry?: (error: Error, attempt: number) => void } = {},
  ): Promise<T> {
    const retries = options.retries ?? 2;
    let lastError: Error | undefined;
    let currentPrompt = prompt;
    for (let attempt = 0; attempt <= retries; attempt++) {
      let lastText: string;
      try {
        lastText = await this.ask(currentPrompt);
      } catch (error) {
        if (!(error instanceof EmptyAgentResponse) || attempt === retries) throw error;
        options.onRetry?.(error, attempt + 1);
        currentPrompt = "上次没有收到正文。请按上面的任务和材料直接给出完整 JSON，保留核心答案和最重要的依据即可。";
        continue;
      }
      try {
        const value = extractJson<T>(lastText);
        options.validate?.(value);
        return value;
      } catch (error) {
        lastError = error as Error;
        if (attempt < retries) options.onRetry?.(lastError, attempt + 1);
        currentPrompt =
          `你的上一条回复未满足输出要求（错误：${lastError.message}）。\n` +
          `请重新输出：只输出一个完整、合法的 JSON 对象，不要 Markdown 代码块，不要任何解释，不要前后缀文字。\n` +
          `必须严格遵循上一轮给出的字段、类型和枚举值。`;
      }
    }
    throw new Error(
      `模型连续 ${retries + 1} 次未返回符合要求的 JSON：${lastError?.message ?? "unknown"}。`,
    );
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribe?.();
    this.#agent.dispose();
  }
}
