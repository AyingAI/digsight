import { createHash, randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import { isIP } from "node:net";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { SourceRef, Verdict } from "./types.ts";

export function nowIso(): string {
  return new Date().toISOString();
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rest = sec % 60;
  if (min < 60) return `${min}m${rest ? `${rest}s` : ""}`;
  const hr = Math.floor(min / 60);
  return `${hr}h${min % 60}m`;
}

export function formatDateHuman(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function truncate(text: string, max: number, suffix = "…"): string {
  if (!text) return "";
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - suffix.length)).trimEnd() + suffix;
}

export function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

/** Models sometimes emit 82 instead of 0.82. Normalize either convention. */
export function normalizeConfidence(value: unknown): number {
  let n = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  if (!Number.isFinite(n)) n = 0;
  if (n > 1) n = n / 100;
  return Math.round(clamp(n, 0, 1) * 100) / 100;
}

export function confidenceLabel(confidence: number): string {
  if (confidence >= 0.75) return "高";
  if (confidence >= 0.55) return "中";
  if (confidence >= 0.35) return "低";
  return "很低";
}

export function normalizeVerdict(value: unknown): Verdict {
  const s = String(value ?? "").toLowerCase().trim().replace(/[\s-]+/g, "_");
  if (["supported", "support", "true", "成立", "支持", "证实", "已证实"].includes(s)) return "supported";
  if (["partially_supported", "partial", "partly", "部分支持", "部分证实", "部分成立"].includes(s)) {
    return "partially_supported";
  }
  if (["refuted", "false", "not_supported", "unsupported", "不成立", "反驳", "被反驳", "不支持", "证伪"].includes(s)) {
    return "refuted";
  }
  return "inconclusive";
}

export function verdictLabel(verdict: Verdict): string {
  switch (verdict) {
    case "supported":
      return "支持";
    case "partially_supported":
      return "部分支持";
    case "refuted":
      return "不支持";
    default:
      return "证据不足";
  }
}

export function normalizeStrength(value: unknown): "strong" | "medium" | "weak" {
  const s = String(value ?? "").toLowerCase();
  if (["strong", "high", "强", "高"].some((x) => s.includes(x))) return "strong";
  if (["weak", "low", "弱", "低"].some((x) => s.includes(x))) return "weak";
  return "medium";
}

export function strengthLabel(value: "strong" | "medium" | "weak"): string {
  return value === "strong" ? "强" : value === "weak" ? "弱" : "中";
}

export function makeRunId(question: string): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(
    d.getMinutes(),
  )}${pad(d.getSeconds())}`;
  const hash = createHash("sha1").update(`${question}:${randomUUID()}`).digest("hex").slice(0, 6);
  return `${stamp}-${hash}`;
}

export function slugify(text: string, max = 48): string {
  const slug = text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return slug || "research";
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
}

export async function writeJson(file: string, data: unknown): Promise<void> {
  await writeText(file, JSON.stringify(data, null, 2));
}

export async function writeText(file: string, text: string): Promise<void> {
  const dir = path.dirname(file);
  await ensureDir(dir);
  const temporary = path.join(dir, `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, text.endsWith("\n") ? text : `${text}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

export async function readJsonSafe<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export async function pathExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Extract the first balanced JSON object from an LLM response.
 * Handles fenced blocks, leading prose, trailing prose, smart quotes around
 * the fence, and trailing commas.
 */
export function extractJson<T = unknown>(raw: string): T {
  if (!raw || typeof raw !== "string") throw new Error("empty model response");
  let text = raw
    .replace(/^\uFEFF/, "")
    .replace(/[\u200B-\u200D\u2060]/g, "")
    .trim();

  const fenced = text.match(/```(?:json|JSON)?\s*\n?([\s\S]*?)```/);
  if (fenced?.[1]) text = fenced[1].trim();

  const start = text.indexOf("{");
  if (start < 0) throw new Error("no JSON object found in model response");

  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end < 0) throw new Error("unbalanced JSON object in model response");

  const candidate = text.slice(start, end);
  try {
    return JSON.parse(candidate) as T;
  } catch {
    // Repair trailing commas only outside strings; evidence text must stay intact.
    let repaired = "";
    let quoted = false;
    let escape = false;
    for (let i = 0; i < candidate.length; i++) {
      const ch = candidate[i]!;
      if (!quoted && ch === "," && /^\s*[}\]]/.test(candidate.slice(i + 1))) continue;
      repaired += ch;
      if (escape) { escape = false; continue; }
      if (quoted && ch === "\\") { escape = true; continue; }
      if (ch === '"') quoted = !quoted;
    }
    try { return JSON.parse(repaired) as T; }
    catch { throw new Error("invalid JSON"); }
  }
}

export function cleanUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const tracking = [...url.searchParams.keys()].filter(
      (key) => /^(utm_|_bhlid$|spm$|from$|source$|ref$|fbclid$|gclid$|yclid$|mc_cid$|mc_eid$)/i.test(key),
    );
    for (const key of tracking) url.searchParams.delete(key);
    url.hash = "";
    return url.toString();
  } catch {
    return raw.trim();
  }
}

export function hasUrlCredentials(url: URL): boolean {
  if (url.username || url.password) return true;
  if (/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/.test(url.href)) return true;
  return [...url.searchParams.keys()].some((key) =>
    /(?:token|signature|password|credential)|^(?:auth|api[-_]?key|session(?:[-_]?id)?|sig|key-pair-id|code|policy)$/i.test(key));
}

/** Syntactic check only. Network requests must also pin a verified public address. */
export function isPublicResearchUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol) || hasUrlCredentials(url) || url.port) return false;
    const host = url.hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
    if (/(^|\.)(localhost|local|internal|test|invalid|onion|home\.arpa)$/.test(host)) return false;
    // IP literal targets are unnecessary for public-source citation checking.
    return !isIP(host) && host.includes(".");
  } catch { return false; }
}

export function redactWebSecrets(text: string): string {
  return text
    .replace(/https?:\/\/[^\s<>"'`]+/gi, (match) => {
      try {
        return hasUrlCredentials(new URL(match.replace(/&amp;/gi, "&"))) ? "[已隐藏含认证信息的链接]" : match;
      } catch { return match; }
    })
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[已隐藏令牌]");
}

export function domainOf(raw: string): string {
  try {
    return new URL(raw).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

const HIGH_QUALITY_DOMAINS = [
  ".gov",
  ".gov.cn",
  ".edu",
  ".edu.cn",
  ".mil",
  "who.int",
  "worldbank.org",
  "imf.org",
  "oecd.org",
  "un.org",
  "europa.eu",
  "nber.org",
  "arxiv.org",
  "ssrn.com",
  "nature.com",
  "science.org",
  "sciencedirect.com",
  "springer.com",
  "pnas.org",
  "doi.org",
  "pubmed.ncbi.nlm.nih.gov",
  "ncbi.nlm.nih.gov",
  "thelancet.com",
  "nejm.org",
  "jamanetwork.com",
  "cell.com",
  "nobelprize.org",
  "kva.se",
  "sec.gov",
  "cninfo.com.cn",
  "hkexnews.hk",
  "sse.com.cn",
  "szse.cn",
  "bse.cn",
  "pbc.gov.cn",
  "csrc.gov.cn",
  "stats.gov.cn",
  "mof.gov.cn",
  "ndrc.gov.cn",
  "miit.gov.cn",
  "customs.gov.cn",
  "federalreserve.gov",
  "ecb.europa.eu",
  "bis.org",
];

const MEDIUM_QUALITY_DOMAINS = [
  "reuters.com",
  "bloomberg.com",
  "ft.com",
  "wsj.com",
  "economist.com",
  "xinhuanet.com",
  "news.cn",
  "people.com.cn",
  "caixin.com",
  "yicai.com",
  "stcn.com",
  "cls.cn",
  "21jingji.com",
  "thepaper.cn",
  "jiemian.com",
  "36kr.com",
  "huxiu.com",
  "nikkei.com",
  "scmp.com",
  "cnbc.com",
  "bbc.com",
  "nytimes.com",
  "washingtonpost.com",
  "theguardian.com",
];

export function classifyDomain(url: string): SourceRef["quality"] {
  const domain = domainOf(url).toLowerCase();
  if (!domain) return "unknown";
  const matches = (value: string) => {
    const suffix = value.replace(/^\./, "");
    return domain === suffix || domain.endsWith(`.${suffix}`);
  };
  if (HIGH_QUALITY_DOMAINS.some(matches)) return "high";
  if (MEDIUM_QUALITY_DOMAINS.some(matches)) return "medium";
  if (/(^|\.)(x\.com|twitter\.com|facebook\.com|reddit\.com|medium\.com|zhihu\.com|weibo\.com|douyin\.com)$/.test(domain)) {
    return "low";
  }
  return "unknown";
}

export function normalizeSourceTitle(title: string | undefined, url?: string): string | undefined {
  const value = (title || "").trim();
  if (!value) return undefined;
  if (/^-?\d+$/.test(value)) return undefined;
  if (/^https?:\/\//i.test(value)) return domainOf(url || value) || undefined;
  return value;
}

export function dedupeSources(sources: SourceRef[]): SourceRef[] {
  const seen = new Set<string>();
  const out: SourceRef[] = [];
  for (const source of sources) {
    const key = source.url ? cleanUrl(source.url) : `${source.site ?? ""}|${source.title ?? ""}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      ...source,
      title: normalizeSourceTitle(source.title, source.url),
      url: source.url ? cleanUrl(source.url) : undefined,
      quality: source.quality ?? (source.url ? classifyDomain(source.url) : "unknown"),
    });
  }
  return out;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function mdCell(text: unknown): string {
  return String(text ?? "")
    .replace(/\r?\n+/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
}

export function stripAnsi(text: string): string {
  return stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

export function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback;
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

export function parseList<T extends string>(value: string | undefined, allowed: readonly T[]): T[] {
  if (!value) return [...allowed];
  const parts = value
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  const valid = parts.filter((x): x is T => (allowed as readonly string[]).includes(x));
  return valid.length ? valid : [...allowed];
}

/**
 * Run async tasks with a concurrency limit, preserving result order.
 */
export async function pMap<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let stopped = false;
  const size = Math.max(1, Math.min(limit, items.length || 1));
  const runners = Array.from({ length: size }, async () => {
    while (true) {
      const index = next++;
      if (stopped || index >= items.length) return;
      try { results[index] = await worker(items[index]!, index); }
      catch (error) { stopped = true; throw error; }
    }
  });
  // Wait for in-flight work before caller cleanup closes the shared browser space.
  const outcomes = await Promise.allSettled(runners);
  const failed = outcomes.find((outcome) => outcome.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
  return results;
}

export function safeFileName(text: string): string {
  return text.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "file";
}

export function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
