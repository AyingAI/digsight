import { readFileSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { browserProcessEnv } from "./browser/ego.ts";
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
export type ModelSource = "requested" | "environment" | "pi-default" | "preferred" | "only-available";
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
  input: { requested?: string; environment?: string; piDefault?: string },
): { model: T; source: ModelSource } {
  const exact = (spec: string): T => {
    const matches = available.filter((m) => `${m.provider}/${m.id}` === spec || m.id === spec);
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) throw new Error(`模型 ${spec} 对应多个提供商，请选择完整的 provider/id。`);
    throw new Error(`模型 ${spec} 不可用或尚未授权。请在 pi 中 /login 授权对应提供商，并用 /model 确认；不会自动切换到其他模型。`);
  };
  for (const [source, spec] of [
    ["requested", input.requested],
    ["environment", input.environment],
    ["pi-default", input.piDefault],
  ] as const) {
    if (spec?.trim()) return { model: exact(spec.trim()), source };
  }
  const preferred = available.filter((model) => model.id === PREFERRED_MODEL_ID);
  if (preferred.length === 1) return { model: preferred[0]!, source: "preferred" };
  if (available.length === 1) return { model: available[0]!, source: "only-available" };
  if (!available.length) {
    throw new Error("尚未连接综合模型。在 pi 中运行 /login 添加 API Key 或登录受支持的订阅，再用 /model 选择默认模型。已有 pi 凭据无需重复填写。");
  }
  throw new Error("检测到多个可用模型。请在高级设置中选择，或在 pi 的 /model 中用 Ctrl+S 保存默认模型。");
}

async function modelCatalog() {
  const dir = piAgentDir();
  const signal = AbortSignal.timeout(10_000);
  const runtime = await ModelRuntime.create({
    authPath: path.join(dir, "auth.json"),
    modelsPath: path.join(dir, "models.json"),
    signal,
  });
  const available = await runtime.getAvailable(undefined, { signal });
  return { runtime, available };
}

function selectionInput(requested?: string) {
  const environment = process.env.DIGSIGHT_MODEL;
  if (requested?.trim() || environment?.trim()) return { requested, environment };
  const defaults = readPiDefaults();
  return {
    requested,
    environment,
    piDefault: defaults.provider && defaults.model ? `${defaults.provider}/${defaults.model}` : undefined,
  };
}

export async function resolveModel(requested?: string): Promise<ResolvedModel> {
  const { runtime, available } = await modelCatalog().catch(() => {
    throw new Error("无法读取 pi 模型配置，请在 pi 中检查授权和 models.json。");
  });
  const { model, source } = selectModel(available, selectionInput(requested));
  return { runtime, model, label: `${model.provider}/${model.id}`, source };
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

/** Public setup data intentionally excludes keys, headers, base URLs and auth-file contents. */
export async function inspectEnvironment() {
  const [model, browser] = await Promise.all([
    (async () => {
      try {
        const { available } = await modelCatalog();
        const models = available.map((m) => ({ id: `${m.provider}/${m.id}`, name: m.id, provider: m.provider }));
        try {
          const selected = selectModel(available, selectionInput());
          return { ok: true, label: `${selected.model.provider}/${selected.model.id}`, source: selected.source, models };
        } catch (error) {
          return { ok: false, error: (error as Error).message, models };
        }
      } catch {
        return { ok: false, error: "无法读取 pi 模型配置。请在终端打开 pi 检查授权和 models.json，然后重新检测。", models: [] };
      }
    })(),
    checkEgoBrowser(),
  ]);
  return { model, browser, checkedAt: new Date().toISOString(), loginChecked: false, skillsRequired: false };
}
