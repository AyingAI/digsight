import { readFileSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { browserProcessEnv } from "./browser/ego.ts";
import { CUSTOM_MODEL_PROVIDER, isModelProvider, MODEL_PROVIDERS, readModelSettings, type ModelSettings } from "./model-settings.ts";
import type { EngineName, RunOptions, ThinkingLevel } from "./types.ts";
import { questionCount } from "./research-plan.ts";
import { ENGINES } from "./types.ts";
import { parseBoolean, parseList } from "./util.ts";

export const DEFAULT_PORT = Number(process.env.DIGSIGHT_PORT || 4317);
export const DEFAULT_RUNS_DIR = path.resolve(process.env.DIGSIGHT_RUNS_DIR || path.join(process.cwd(), "runs"));
export const PREFERRED_MODEL_ID = "deepseek-v4.1-flash";

export function defaultOptions(overrides: Partial<RunOptions> = {}): RunOptions {
  return {
    question: "",
    engines: [...ENGINES],
    subQuestionCount: questionCount(process.env.DIGSIGHT_QUESTIONS || "auto"),
    concurrency: Number(process.env.DIGSIGHT_CONCURRENCY || 2),
    model: process.env.DIGSIGHT_MODEL,
    thinkingLevel: (process.env.DIGSIGHT_THINKING as ThinkingLevel) || "high",
    researchTimeoutMs: Number(process.env.DIGSIGHT_TIMEOUT_MS || 15 * 60 * 1000),
    verifyCitations: parseBoolean(process.env.DIGSIGHT_VERIFY_CITATIONS, true),
    maxCitations: Number(process.env.DIGSIGHT_MAX_CITATIONS || 10),
    keepSpace: parseBoolean(process.env.DIGSIGHT_KEEP_SPACE, false),
    saveRawHtml: parseBoolean(process.env.DIGSIGHT_SAVE_RAW_HTML, false),
    runsDir: DEFAULT_RUNS_DIR,
    ...overrides,
  };
}

export function normalizeOptions(input: Partial<RunOptions> & { question: string }): RunOptions {
  const options = defaultOptions(input);
  options.question = String(options.question || "").trim();
  options.engines = normalizeEngines(options.engines);
  options.subQuestionCount = questionCount(options.subQuestionCount);
  options.concurrency = Math.max(1, Math.min(6, Math.round(Number(options.concurrency) || 2)));
  options.maxCitations = Math.max(0, Math.min(30, Math.round(Number(options.maxCitations) || 0)));
  options.researchTimeoutMs = Math.max(60_000, Math.min(60 * 60 * 1000, Number(options.researchTimeoutMs) || 900_000));
  if (!["off", "low", "medium", "high"].includes(options.thinkingLevel)) options.thinkingLevel = "high";
  options.runsDir = path.resolve(options.runsDir || DEFAULT_RUNS_DIR);
  return options;
}

export function normalizeEngines(value: unknown): EngineName[] {
  if (Array.isArray(value)) {
    const valid = value.filter((item): item is EngineName => (ENGINES as readonly string[]).includes(String(item)));
    return valid.length ? [...new Set(valid)] : [...ENGINES];
  }
  return parseList(typeof value === "string" ? value : undefined, ENGINES);
}

export type RuntimeModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;
export type ModelSource = "requested" | "environment" | "digsight-default" | "pi-default" | "preferred" | "only-available";
export interface ResolvedModel {
  runtime: ModelRuntime;
  model: RuntimeModel;
  label: string;
  source: ModelSource;
}

// Use Pi's own directory contract; retain the old app-specific alias for compatibility.
export function piAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ? getAgentDir() : path.resolve(process.env.PI_AGENT_DIR || getAgentDir());
}

export function readPiDefaults(): { provider?: string; model?: string } {
  try {
    const data = JSON.parse(readFileSync(path.join(piAgentDir(), "settings.json"), "utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("settings.json 必须是对象");
    return {
      provider: typeof data.defaultProvider === "string" ? data.defaultProvider : undefined,
      model: typeof data.defaultModel === "string" ? data.defaultModel : undefined,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error("无法读取 pi 的 settings.json，请修复配置后重试；不会自动改用其他默认模型。");
  }
}

/** Select only credential-ready models. Never silently replace an explicit choice. */
export function selectModel<T extends { provider: string; id: string }>(
  available: readonly T[],
  input: { requested?: string; environment?: string; appDefault?: string; piDefault?: string },
): { model: T; source: ModelSource } {
  const exact = (spec: string): T => {
    const matches = available.filter((m) => `${m.provider}/${m.id}` === spec || m.id === spec);
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) throw new Error(`模型 ${spec} 对应多个提供商，请选择完整的 provider/id。`);
    throw new Error(`模型 ${spec} 不可用或尚未授权。请在「运行环境」配置对应提供商，或选择其他模型。`);
  };
  for (const [source, spec] of [
    ["requested", input.requested],
    ["environment", input.environment],
    ["digsight-default", input.appDefault],
    ["pi-default", input.piDefault],
  ] as const) {
    if (spec?.trim()) return { model: exact(spec.trim()), source };
  }
  const preferred = available.filter((model) => model.id === PREFERRED_MODEL_ID);
  if (preferred.length === 1) return { model: preferred[0]!, source: "preferred" };
  if (available.length === 1) return { model: available[0]!, source: "only-available" };
  if (!available.length) {
    throw new Error("尚未连接综合模型。请在「运行环境」添加 API Key。");
  }
  throw new Error("检测到多个可用模型。请在「运行环境」选择默认模型。");
}

export async function modelCatalog(settings?: ModelSettings) {
  const { keys, defaultModel, custom } = settings ?? await readModelSettings();
  const dir = piAgentDir();
  const signal = AbortSignal.timeout(10_000);
  const managed = (provider: string) => provider === CUSTOM_MODEL_PROVIDER ? Boolean(custom) : isModelProvider(provider) && keys[provider] !== undefined;
  const configured = Object.keys(keys);
  if (custom) configured.push(CUSTOM_MODEL_PROVIDER);
  const [pi, app] = await Promise.all([
    ModelRuntime.create({
      authPath: path.join(dir, "auth.json"),
      modelsPath: path.join(dir, "models.json"),
      signal,
    }).catch((error: unknown) => {
      if (!configured.length) throw error;
      return undefined;
    }),
    configured.length ? ModelRuntime.create({
      // UI keys must use the built-in endpoints, even if a Pi config overrides them.
      modelsPath: null,
      signal,
      credentials: {
        async read(providerId) {
          const key = providerId === CUSTOM_MODEL_PROVIDER && custom
            ? custom.apiKey ?? "digsight-local"
            : isModelProvider(providerId) ? keys[providerId] : undefined;
          return key ? { type: "api_key", key } : undefined;
        },
        async list() { return configured.map(providerId => ({ providerId, type: "api_key" })); },
        async modify() { throw new Error("凭据只能在 Digsight 设置中更新。"); },
        async delete() { throw new Error("凭据只能在 Digsight 设置中移除。"); },
      },
    }) : undefined,
  ]);
  if (app && custom) {
    app.registerProvider(CUSTOM_MODEL_PROVIDER, {
      name: "自定义",
      baseUrl: custom.baseUrl,
      api: "openai-completions",
      models: [{
        id: custom.modelId,
        name: custom.modelId,
        input: ["text"],
        reasoning: false,
        contextWindow: 128_000,
        maxTokens: 8_192,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: { supportsDeveloperRole: false, supportsStore: false, maxTokensField: "max_tokens" },
      }],
    });
  }
  const available = [
    ...(pi?.getAvailableSnapshot().filter(model => !managed(model.provider)) ?? []),
    ...(app ? (await app.getAvailable(undefined, { signal })).filter(model => managed(model.provider)) : []),
  ];
  return {
    available,
    defaultModel,
    providers: [
      ...MODEL_PROVIDERS.map(provider => ({ ...provider, configured: managed(provider.id) })),
      { id: CUSTOM_MODEL_PROVIDER, name: "自定义", configured: Boolean(custom) },
    ],
    custom: custom ? { baseUrl: custom.baseUrl, modelId: custom.modelId, hasKey: Boolean(custom.apiKey) } : undefined,
    runtimeFor: (provider: string) => (managed(provider) ? app : pi)!,
  };
}

function selectionInput(appDefault?: string, requested?: string) {
  const environment = process.env.DIGSIGHT_MODEL;
  if (requested?.trim() || environment?.trim() || appDefault) return { requested, environment, appDefault };
  const defaults = readPiDefaults();
  return {
    requested,
    environment,
    piDefault: defaults.provider && defaults.model ? `${defaults.provider}/${defaults.model}` : undefined,
  };
}

export async function resolveModel(requested?: string): Promise<ResolvedModel> {
  const { runtimeFor, available, defaultModel } = await modelCatalog().catch(() => {
    throw new Error("无法读取本机模型配置，请检查 Digsight 设置或 Pi 配置。");
  });
  const { model, source } = selectModel(available, selectionInput(defaultModel, requested));
  return { runtime: runtimeFor(model.provider), model, label: `${model.provider}/${model.id}`, source };
}

export async function checkEgoBrowser(): Promise<{ ok: boolean; version?: string; error?: string }> {
  return await new Promise((resolve) => {
    execFile("ego-browser", ["--version"], { env: browserProcessEnv(), timeout: 5000, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        resolve({ ok: false, error: "未检测到可用的 ego-browser。请安装 Ego Lite、完成首次引导，并确认命令已加入 PATH；不需要安装 Skill。" });
      } else {
        resolve({ ok: true, version: (stdout + stderr).trim().split("\n")[0] });
      }
    });
  });
}

/** Setup exposes the user-entered custom address and status, never credential values. */
export async function inspectEnvironment() {
  const [model, browser] = await Promise.all([
    (async () => {
      try {
        const { available, defaultModel, providers, custom } = await modelCatalog();
        const models = available.map((m) => ({ id: `${m.provider}/${m.id}`, name: m.id, provider: m.provider }));
        try {
          const selected = selectModel(available, selectionInput(defaultModel));
          return { ok: true, label: `${selected.model.provider}/${selected.model.id}`, source: selected.source, models, providers, defaultModel, custom };
        } catch (error) {
          return { ok: false, error: (error as Error).message, models, providers, defaultModel, custom };
        }
      } catch {
        return { ok: false, error: "无法读取本机模型配置。请检查 Digsight 设置或 Pi 配置后重新检测。", models: [], providers: [], defaultModel: undefined };
      }
    })(),
    checkEgoBrowser(),
  ]);
  return { model, browser, checkedAt: new Date().toISOString(), loginChecked: false, skillsRequired: false };
}
