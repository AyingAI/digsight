import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { writeJson } from "./util.ts";

export const MODEL_PROVIDERS = [
  { id: "deepseek", name: "DeepSeek", keyUrl: "https://platform.deepseek.com/api_keys" },
  { id: "opencode-go", name: "OpenCode Go", keyUrl: "https://opencode.ai/console" },
  { id: "openrouter", name: "OpenRouter", keyUrl: "https://openrouter.ai/settings/keys" },
  { id: "openai", name: "OpenAI", keyUrl: "https://platform.openai.com/api-keys" },
  { id: "anthropic", name: "Anthropic", keyUrl: "https://platform.claude.com/settings/keys" },
  { id: "google", name: "Google Gemini", keyUrl: "https://aistudio.google.com/apikey" },
] as const;

export const CUSTOM_MODEL_PROVIDER = "digsight-custom";
export interface CustomModelSettings {
  baseUrl: string;
  modelId: string;
  apiKey?: string;
}

type ProviderId = typeof MODEL_PROVIDERS[number]["id"];
export interface ModelSettings {
  keys: Partial<Record<ProviderId, string>>;
  defaultModel?: string;
  custom?: CustomModelSettings;
}

const SETTINGS_PATH = path.join(path.resolve(process.env.DIGSIGHT_CONFIG_DIR || path.join(homedir(), ".digsight")), "credentials.json");

export function isModelProvider(value: unknown): value is ProviderId {
  return MODEL_PROVIDERS.some(({ id }) => value === id);
}

export function isApiKey(value: unknown): value is string {
  return typeof value === "string" && /^[\x21-\x7e]{8,2048}$/.test(value) && !value.startsWith("!");
}

function isLocalModelUrl(url: URL): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

export function customModelAddress(baseUrl: unknown, modelId: unknown): { baseUrl: string; modelId: string; local: boolean } | undefined {
  if (typeof baseUrl !== "string" || baseUrl.length > 2048 || /[\s?#\\]/.test(baseUrl)) return undefined;
  if (typeof modelId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.:/@+-]{0,199}$/.test(modelId)) return undefined;
  try {
    const url = new URL(baseUrl);
    const local = isLocalModelUrl(url);
    if (!/^https?:\/\//i.test(baseUrl) || (url.protocol === "http:" && !local) || url.username || url.password) return undefined;
    const base = url.href.replace(/\/+$/, "");
    if (/\/(?:chat\/completions|models)$/i.test(base)) return undefined;
    return { baseUrl: base, modelId, local };
  } catch { return undefined; }
}

export async function readModelSettings(): Promise<ModelSettings> {
  try {
    const saved = JSON.parse(await fs.readFile(SETTINGS_PATH, "utf8"));
    if (!saved || typeof saved.keys !== "object" || !saved.keys || Array.isArray(saved.keys) ||
        (saved.defaultModel !== undefined && typeof saved.defaultModel !== "string")) throw new Error();
    const keys: ModelSettings["keys"] = {};
    for (const [provider, key] of Object.entries(saved.keys)) {
      if (!isModelProvider(provider) || !isApiKey(key)) throw new Error();
      keys[provider] = key;
    }
    let custom: CustomModelSettings | undefined;
    if (saved.custom !== undefined) {
      const address = customModelAddress(saved.custom?.baseUrl, saved.custom?.modelId);
      const apiKey: unknown = saved.custom?.apiKey;
      if (!address || (apiKey !== undefined ? !isApiKey(apiKey) : !address.local)) throw new Error();
      custom = { baseUrl: address.baseUrl, modelId: address.modelId, apiKey: typeof apiKey === "string" ? apiKey : undefined };
    }
    return { keys, defaultModel: saved.defaultModel, custom };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { keys: {} };
    throw new Error("无法读取 Digsight 的本机模型配置。");
  }
}

export async function writeModelSettings(settings: ModelSettings): Promise<void> {
  await writeJson(SETTINGS_PATH, settings);
}
