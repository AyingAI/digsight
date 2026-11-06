import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { EngineName, EnginePreflight, Material, PreflightResult } from "../types.ts";
import { ensureDir, nowIso, parseBoolean, readJsonSafe, redactWebSecrets } from "../util.ts";

export interface EgoRunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  label?: string;
  allowNonZero?: boolean;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
}

export interface EgoRunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  durationMs: number;
}

export class EgoError extends Error {
  stdout: string;
  stderr: string;
  code: number | null;

  constructor(message: string, result: Partial<EgoRunResult>) {
    super(message);
    this.name = "EgoError";
    this.stdout = result.stdout ?? "";
    this.stderr = result.stderr ?? "";
    this.code = result.code ?? null;
  }
}

const MAX_CAPTURE = 4 * 1024 * 1024;
const SAVE_SCREENSHOTS = parseBoolean(process.env.DIGSIGHT_SAVE_SCREENSHOTS, false);

export function browserProcessEnv(): NodeJS.ProcessEnv {
  const inherited = /^(?:PATH|PATHEXT|HOME|USER|LOGNAME|USERPROFILE|APPDATA|LOCALAPPDATA|SYSTEMROOT|WINDIR|COMSPEC|TMPDIR|TMP|TEMP|LANG|LC_\w+|XDG_(?:CONFIG|DATA|STATE|CACHE|RUNTIME)_HOME|XDG_RUNTIME_DIR)$/i;
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => inherited.test(name)));
}

/**
 * Run a script inside ego-browser's Node.js runtime. The script receives the
 * global TaskSpace/Page helpers documented by `ego-browser skill`.
 */
export async function runEgoScript(script: string, options: EgoRunOptions = {}): Promise<EgoRunResult> {
  if (options.signal?.aborted) throw new Error("cancelled");
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
  const started = Date.now();
  return await new Promise((resolve, reject) => {
    const child = spawn("ego-browser", ["nodejs"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: browserProcessEnv(),
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let stdoutBuffer = "";
    let stderrBuffer = "";

    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const terminate = () => {
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), 3000);
      killTimer.unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs + 10_000);
    const onAbort = () => terminate();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const append = (current: string, chunk: string) => {
      const next = current + chunk;
      return next.length > MAX_CAPTURE ? next.slice(next.length - MAX_CAPTURE) : next;
    };

    child.stdout.on("data", (data) => {
      const text = data.toString();
      stdout = append(stdout, text);
      stdoutBuffer = append(stdoutBuffer, text);
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) options.onStdoutLine?.(line);
      }
    });

    child.stderr.on("data", (data) => {
      const text = data.toString();
      stderr = append(stderr, text);
      stderrBuffer = append(stderrBuffer, text);
      const lines = stderrBuffer.split("\n");
      stderrBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) options.onStderrLine?.(line);
      }
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      clearTimeout(killTimer);
      reject(new EgoError(`无法启动 ego-browser：${error.message}`, { stdout, stderr }));
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (stdoutBuffer.trim()) options.onStdoutLine?.(stdoutBuffer);
      if (stderrBuffer.trim()) options.onStderrLine?.(stderrBuffer);
      clearTimeout(killTimer);
      if (options.signal?.aborted) { reject(new Error("cancelled")); return; }
      const result: EgoRunResult = {
        stdout,
        stderr,
        code,
        timedOut,
        durationMs: Date.now() - started,
      };
      if (timedOut) {
        reject(new EgoError(`${options.label ?? "ego 任务"}超时（${Math.round(timeoutMs / 1000)}s）`, result));
        return;
      }
      if (code !== 0 && !options.allowNonZero) {
        reject(new EgoError(`${options.label ?? "ego 任务"}失败（exit ${code}）`, result));
        return;
      }
      resolve(result);
    });

    child.stdin.on("error", () => { /* close/error owns process failure, including EPIPE */ });
    child.stdin.end(script);
    if (options.signal?.aborted) onAbort();
  });
}

export async function createTaskSpace(name: string): Promise<number> {
  const script = `const task = await taskSpace(${JSON.stringify(name)});\nconsole.log("DIGSIGHT_SPACE_ID=" + task.spaceId);`;
  const result = await runEgoScript(script, { timeoutMs: 90_000, label: "创建 ego TaskSpace" });
  const combined = result.stdout + "\n" + result.stderr;
  const match = combined.match(/DIGSIGHT_SPACE_ID=(\d+)/);
  if (!match) throw new Error("未能创建 ego TaskSpace");
  return Number(match[1]);
}

export async function finishTaskSpace(spaceId: number): Promise<void> {
  const script = `const task = await taskSpace(${JSON.stringify(spaceId)});\nawait task.finish({ keep: [] });\nconsole.log("DIGSIGHT_SPACE_FINISHED");`;
  await runEgoScript(script, { timeoutMs: 60_000, label: "关闭 ego TaskSpace" });
}

function lineProgress(onLine: ((message: string, data?: unknown) => void) | undefined, line: string): void {
  if (!line.startsWith("DIGSIGHT_PROGRESS ")) return;
  try {
    const payload = JSON.parse(line.slice("DIGSIGHT_PROGRESS ".length));
    onLine?.(redactWebSecrets(String(payload.message ?? "浏览器进度")), payload.data);
  } catch {
    // ignore malformed progress lines
  }
}

/* -------------------------------------------------------------------------- */
/* Preflight                                                                  */
/* -------------------------------------------------------------------------- */

export async function preflightBrowsers(input: {
  spaceId: number;
  engines: EngineName[];
  shotsDir: string;
  resultPath: string;
  signal?: AbortSignal;
  onProgress?: (engine: EngineName, message: string) => void;
}): Promise<PreflightResult> {
  await ensureDir(path.dirname(input.resultPath));
  if (SAVE_SCREENSHOTS) await ensureDir(input.shotsDir);
  const config = {
    spaceId: input.spaceId,
    engines: input.engines,
    shotsDir: SAVE_SCREENSHOTS ? input.shotsDir : "",
    resultPath: input.resultPath,
  };
  const script = `const INPUT = ${JSON.stringify(config)};
const fs = await import("node:fs/promises");
const task = await taskSpace(INPUT.spaceId);
const out = { engines: {}, keepPages: false };

async function saveShot(page, origin, name) {
  if (!INPUT.shotsDir || !page) return;
  try {
    if (await page.evaluate(() => location.origin) === origin) {
      await page.screenshot({ path: INPUT.shotsDir + "/" + name });
    }
  } catch {}
}

async function checkDeepSeek() {
  const rec = { engine: "deepseek", ok: false, needsUserAction: false };
  let page = null;
  try {
    page = task.page("p1");
    await page.goto("https://chat.deepseek.com/", { timeout: 90000 });
    try { await page.waitForSelector('textarea[name="search"], textarea', { timeout: 30000 }); } catch {}
    await page.waitForTimeout(1000);
    const state = await page.evaluate(() => ({
      url: location.href,
      body: (document.body.innerText || "").slice(0, 2500),
      hasInput: !!document.querySelector('textarea[name="search"], textarea'),
    }));
    if (new URL(state.url).origin === "https://chat.deepseek.com" && state.hasInput) {
      rec.ok = true;
      await page.close();
      page = null;
    } else {
      const portal = /maccauth|ruijie|上网认证|WiFi认证|网络认证/i.test(state.url + " " + state.body);
      rec.needsUserAction = portal || /登录|扫码|sign in|log in|验证/i.test(state.body);
      rec.error = portal
        ? "网络需要先完成 WiFi 认证（检测到网络认证页）"
        : rec.needsUserAction
          ? "DeepSeek 未登录或需要人机验证"
          : "找不到 DeepSeek 输入框";
      await saveShot(page, "https://chat.deepseek.com", "preflight-deepseek.png");
    }
  } catch (error) {
    rec.error = "DeepSeek 页面未能加载，请在 Ego Lite 检查网络与登录";
    await saveShot(page, "https://chat.deepseek.com", "preflight-deepseek.png");
  }
  return rec;
}

async function checkWorkBuddy() {
  const rec = { engine: "workbuddy", ok: false, needsUserAction: false };
  let page = null;
  try {
    page = await task.newPage();
    await page.goto("https://www.workbuddy.cn/app", { timeout: 120000 });
    try { await page.waitForSelector('div[data-slate-editor="true"], [contenteditable="true"]', { timeout: 25000 }); } catch {}
    await page.waitForTimeout(2000);
    let state = await page.evaluate(() => ({
      url: location.href,
      body: (document.body.innerText || "").slice(0, 3000),
      hasEditor: !!document.querySelector('div[data-slate-editor="true"], [contenteditable="true"]'),
    }));
    if (new URL(state.url).origin === "https://www.workbuddy.cn" && !state.hasEditor) {
      try {
        await page.click('text="新建任务"');
        await page.waitForTimeout(2500);
        state = await page.evaluate(() => ({
          url: location.href,
          body: (document.body.innerText || "").slice(0, 3000),
          hasEditor: !!document.querySelector('div[data-slate-editor="true"], [contenteditable="true"]'),
        }));
      } catch {}
    }
    if (new URL(state.url).origin === "https://www.workbuddy.cn" && state.hasEditor) {
      rec.ok = true;
      await page.close();
      page = null;
    } else {
      const portal = /maccauth|ruijie|上网认证|WiFi认证|网络认证/i.test(state.url + " " + state.body);
      rec.needsUserAction = portal || /登录|扫码|sign in|log in|验证/i.test(state.body);
      rec.error = portal
        ? "网络需要先完成 WiFi 认证（检测到网络认证页）"
        : rec.needsUserAction
          ? "WorkBuddy 未登录或需要人机验证"
          : "找不到 WorkBuddy 输入框";
      await saveShot(page, "https://www.workbuddy.cn", "preflight-workbuddy.png");
    }
  } catch (error) {
    rec.error = "WorkBuddy 页面未能加载，请在 Ego Lite 检查网络与登录";
    await saveShot(page, "https://www.workbuddy.cn", "preflight-workbuddy.png");
  }
  return rec;
}

for (const engine of INPUT.engines) {
  console.log("DIGSIGHT_PROGRESS " + JSON.stringify({ engine, message: "检查登录状态与页面结构" }));
  const rec = engine === "deepseek" ? await checkDeepSeek() : await checkWorkBuddy();
  out.engines[engine] = rec;
  if (!rec.ok && rec.needsUserAction) out.keepPages = true;
  console.log("DIGSIGHT_PROGRESS " + JSON.stringify({ engine, message: rec.ok ? "可用" : rec.error, data: rec }));
}

await fs.writeFile(INPUT.resultPath, JSON.stringify(out, null, 2), { encoding: "utf8", mode: 0o600 });
console.log("DIGSIGHT_PREFLIGHT_DONE " + JSON.stringify({ ok: Object.values(out.engines).filter(e => e.ok).length, keepPages: out.keepPages }));`;

  await runEgoScript(script, {
    timeoutMs: 5 * 60 * 1000,
    label: "浏览器预检",
    signal: input.signal,
    allowNonZero: true,
    onStdoutLine: (line) => {
      if (!line.startsWith("DIGSIGHT_PROGRESS ")) return;
      try {
        const payload = JSON.parse(line.slice("DIGSIGHT_PROGRESS ".length));
        if (payload.engine) input.onProgress?.(payload.engine, String(payload.message ?? ""));
      } catch {
        // ignore
      }
    },
  });

  const parsed = await readJsonSafe<PreflightResult>(input.resultPath);
  if (parsed) return parsed;

  // Fall back to a structured failure so the pipeline can report it cleanly.
  const engines: Record<string, EnginePreflight> = {};
  for (const engine of input.engines) {
    engines[engine] = {
      engine,
      ok: false,
      needsUserAction: false,
      error: "浏览器预检未返回结果",
    };
  }
  return { engines, keepPages: false };
}

/* -------------------------------------------------------------------------- */
/* Engine jobs                                                                */
/* -------------------------------------------------------------------------- */

export interface EngineJobInput {
  spaceId: number;
  subQuestionId: string;
  question: string;
  prompt: string;
  timeoutMs: number;
  resultPath: string;
  rawHtmlPath: string;
  failureShotPath: string;
  signal?: AbortSignal;
  onProgress?: (message: string, data?: unknown) => void;
}

export async function runEngineJob(engine: EngineName, input: EngineJobInput): Promise<Material> {
  // The browser writes untrusted output here. Only the normalized copy is served.
  const resultPath = path.join(path.dirname(input.resultPath), `.${engine}.browser-result.json`);
  const config = {
    spaceId: input.spaceId,
    engine,
    subQuestionId: input.subQuestionId,
    question: input.question,
    prompt: input.prompt,
    timeoutMs: input.timeoutMs,
    resultPath,
    rawHtmlPath: input.rawHtmlPath,
    failureShotPath: SAVE_SCREENSHOTS ? input.failureShotPath : "",
  };
  const script = engine === "deepseek" ? deepSeekScript(config) : workBuddyScript(config);
  try {
    const run = await runEgoScript(script, {
      timeoutMs: input.timeoutMs + 3 * 60 * 1000,
      label: `${engine} 调研`,
      signal: input.signal,
      allowNonZero: true,
      onStdoutLine: (line) => {
        lineProgress((message, data) => input.onProgress?.(message, data), line);
      },
    });
    const material = await readJsonSafe<Material>(resultPath);
    if (!material) return makeFailedMaterial(engine, input, "failed", `ego 进程结束但未写出结果（exit ${run.code}）`);
    if (material.status === "needs_user_action") material.needsUserAction = true;
    return material;
  } catch (error) {
    if (input.signal?.aborted) throw new Error("cancelled");
    const message = (error as Error).message;
    const partial = await readJsonSafe<Material>(resultPath);
    if (partial) return partial;
    return makeFailedMaterial(engine, input, message.includes("超时") ? "timeout" : "failed", message);
  } finally {
    await fs.rm(resultPath, { force: true }).catch(() => {});
  }
}

function makeFailedMaterial(
  engine: EngineName,
  input: EngineJobInput,
  status: "failed" | "timeout",
  error: string,
): Material {
  return {
    id: `${input.subQuestionId}-${engine}`,
    subQuestionId: input.subQuestionId,
    engine,
    question: input.question,
    prompt: input.prompt,
    status,
    error,
    startedAt: nowIso(),
    finishedAt: nowIso(),
    durationMs: 0,
    answerMarkdown: "",
    answerText: "",
    citations: [],
    searchSources: [],
    notes: ["由 DIGSIGHT 宿主进程补写的失败记录"],
  };
}

function deepSeekScript(input: Record<string, unknown>): string {
  return `const INPUT = ${JSON.stringify(input)};
const fs = await import("node:fs/promises");
const ORIGIN = "https://chat.deepseek.com";
const startedAt = new Date().toISOString();
const t0 = Date.now();
const result = {
  id: INPUT.subQuestionId + "-deepseek",
  subQuestionId: INPUT.subQuestionId,
  engine: "deepseek",
  question: INPUT.question,
  prompt: INPUT.prompt,
  status: "failed",
  error: null,
  needsUserAction: false,
  conversationUrl: null,
  pageTitle: null,
  startedAt,
  finishedAt: null,
  durationMs: 0,
  answerMarkdown: "",
  answerText: "",
  citations: [],
  searchSources: [],
  searchCount: 0,
  rawText: "",
  rawHtmlPath: null,
  failureScreenshot: null,
  notes: []
};
let page = null;

function dedupeLinks(links) {
  const seen = new Set();
  const out = [];
  for (const link of links) {
    if (!link || !link.url) continue;
    const key = String(link.url).split("#")[0];
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ url: link.url, title: (link.title || "").trim() });
  }
  return out;
}

try {
  const task = await taskSpace(INPUT.spaceId);
  page = await task.newPage();
  console.log("DIGSIGHT_PROGRESS " + JSON.stringify({ message: "打开 DeepSeek" }));
  await page.goto("https://chat.deepseek.com/", { timeout: 90000 });
  await page.waitForTimeout(2200);

  const initialState = await page.evaluate(() => ({
    hasInput: !!document.querySelector('textarea[name="search"], textarea'),
    body: (document.body.innerText || "").slice(0, 2500),
    url: location.href,
    title: document.title
  }));
  if (new URL(initialState.url).origin !== ORIGIN || !initialState.hasInput) {
    const portal = /maccauth|ruijie|上网认证|WiFi认证|网络认证/i.test(initialState.url + " " + initialState.body);
    const needs = portal || /登录|扫码|sign in|log in|验证/i.test(initialState.body);
    result.status = needs ? "needs_user_action" : "failed";
    result.needsUserAction = needs;
    result.error = portal
      ? "网络需要先完成 WiFi 认证（检测到网络认证页）"
      : needs
        ? "DeepSeek 未登录或需要人机验证"
        : "找不到 DeepSeek 输入框";
    throw new Error(result.error);
  }
  await page.waitForSelector('textarea[name="search"]', { timeout: 60000 });

  const msgCount = await page.evaluate(() => document.querySelectorAll(".ds-message").length);
  if (msgCount > 0) {
    await page.click('text="开启新对话"');
    await page.waitForTimeout(1200);
    if (await page.evaluate(() => !!document.querySelector(".ds-message"))) throw new Error("未能开启 DeepSeek 新对话");
  }

  async function setToggle(label) {
    const state = await page.evaluate((label) => {
      const target = [...document.querySelectorAll(".ds-toggle-button")].find((el) => (el.textContent || "").includes(label));
      return target ? target.getAttribute("aria-pressed") : null;
    }, label);
    if (state === "false") {
      try {
        await page.click('loc=css:.ds-toggle-button:has-text("' + label + '")');
        await page.waitForTimeout(450);
      } catch (error) {
        result.notes.push("开启 " + label + " 失败：" + error.message);
      }
    }
    return state;
  }
  const deepThink = await setToggle("深度思考");
  const webSearch = await setToggle("智能搜索");
  result.notes.push("toggles: deepThink=" + deepThink + ", webSearch=" + webSearch);

  console.log("DIGSIGHT_PROGRESS " + JSON.stringify({ message: "提交调研问题" }));
  if (await page.evaluate(() => location.origin) !== ORIGIN) throw new Error("DeepSeek 已跳转到其他网站，停止提交");
  await page.fill('textarea[name="search"]', INPUT.prompt);
  if (await page.evaluate(() => location.origin) !== ORIGIN) throw new Error("DeepSeek 已跳转到其他网站，停止提交");
  await page.keyboard.press("Enter");

  const deadline = Date.now() + INPUT.timeoutMs;
  let lastText = "";
  let stableSince = 0;
  let sawAny = false;
  let completed = false;
  let lastSearchCount = 0;

  while (Date.now() < deadline) {
    await page.waitForTimeout(3500);
    const state = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll(".ds-assistant-message-main-content")];
      const last = nodes[nodes.length - 1];
      const text = last ? (last.innerText || "") : "";
      const body = document.body.innerText || "";
      const match = body.match(/搜索到\\s*(\\d+)\\s*个网页/);
      const stop = [...document.querySelectorAll('[role="button"]')].some((el) =>
        /停止/.test((el.getAttribute("aria-label") || "") + " " + (el.textContent || ""))
      );
      const error = /(服务器繁忙|请求失败|网络异常|出错了|请稍后重试)/.test(text);
      return { text, chars: text.length, searchCount: match ? Number(match[1]) : 0, stop, error, bodyLength: body.length };
    });
    if (state.searchCount) lastSearchCount = state.searchCount;
    if (state.error) {
      result.error = "DeepSeek 返回错误提示";
      break;
    }
    if (state.chars > 0) {
      if (state.text !== lastText) {
        lastText = state.text;
        stableSince = Date.now();
        sawAny = true;
        console.log("DIGSIGHT_PROGRESS " + JSON.stringify({ message: "DeepSeek 正在生成", data: { chars: state.chars } }));
      }
      if (!state.stop && Date.now() - stableSince > 15000) {
        completed = true;
        break;
      }
    }
  }

  if (!sawAny) throw new Error("等待 DeepSeek 回答超时或回答为空");
  if (!completed) result.notes.push("未检测到明确完成信号，按最后一次稳定内容保存");

  const data = await page.evaluate((captureHtml) => {
    const nodes = [...document.querySelectorAll(".ds-assistant-message-main-content")];
    const last = nodes[nodes.length - 1];
    const links = [];
    if (last) {
      for (const anchor of last.querySelectorAll('a[href^="http"]')) {
        links.push({ url: anchor.href, title: (anchor.textContent || "").trim() });
      }
    }
    const body = document.body.innerText || "";
    const match = body.match(/搜索到\\s*(\\d+)\\s*个网页/);
    return {
      answerText: last ? (last.innerText || "") : "",
      answerHtml: captureHtml && last ? last.innerHTML : "",
      links,
      searchCount: match ? Number(match[1]) : 0,
      pageTitle: document.title,
      url: location.href
    };
  }, Boolean(INPUT.rawHtmlPath));
  if (new URL(data.url).origin !== ORIGIN) throw new Error("DeepSeek 已跳转到其他网站，停止采集");

  result.answerText = data.answerText || lastText;
  result.answerMarkdown = result.answerText;
  result.citations = dedupeLinks(data.links);
  result.searchCount = data.searchCount || lastSearchCount;
  result.pageTitle = data.pageTitle;
  result.conversationUrl = data.url.split(/[?#]/, 1)[0];
  if (!result.answerText.trim()) throw new Error("DeepSeek 回答为空");

  if (INPUT.rawHtmlPath) {
    try {
      await fs.writeFile(INPUT.rawHtmlPath, data.answerHtml || "", { encoding: "utf8", mode: 0o600 });
      result.rawHtmlPath = INPUT.rawHtmlPath;
    } catch (error) {
      result.notes.push("写 raw html 失败：" + error.message);
    }
  }
  result.status = "ok";
} catch (error) {
  result.error = result.error || (error && error.message ? error.message : String(error));
  if (page && INPUT.failureShotPath && !result.needsUserAction) {
    try {
      if (await page.evaluate(() => location.origin) === ORIGIN) {
        await page.screenshot({ path: INPUT.failureShotPath });
        result.failureScreenshot = INPUT.failureShotPath;
      }
    } catch {}
  }
} finally {
  result.finishedAt = new Date().toISOString();
  result.durationMs = Date.now() - t0;
  try {
    await fs.writeFile(INPUT.resultPath, JSON.stringify(result, null, 2), { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    console.error("DIGSIGHT_RESULT_WRITE_FAILED " + (error && error.message ? error.message : String(error)));
  }
  if (page && !result.needsUserAction) {
    try { await page.close(); } catch {}
  }
  console.log("DIGSIGHT_RESULT " + JSON.stringify({
    engine: "deepseek",
    status: result.status,
    answerChars: result.answerText.length,
    citations: result.citations.length,
    error: result.error
  }));
}`;
}

function workBuddyScript(input: Record<string, unknown>): string {
  return `const INPUT = ${JSON.stringify(input)};
const fs = await import("node:fs/promises");
const ORIGIN = "https://www.workbuddy.cn";
const startedAt = new Date().toISOString();
const t0 = Date.now();
const result = {
  id: INPUT.subQuestionId + "-workbuddy",
  subQuestionId: INPUT.subQuestionId,
  engine: "workbuddy",
  question: INPUT.question,
  prompt: INPUT.prompt,
  status: "failed",
  error: null,
  needsUserAction: false,
  conversationUrl: null,
  pageTitle: null,
  startedAt,
  finishedAt: null,
  durationMs: 0,
  answerMarkdown: "",
  answerText: "",
  citations: [],
  searchSources: [],
  searchCount: undefined,
  rawText: "",
  rawHtmlPath: null,
  failureScreenshot: null,
  notes: []
};
let page = null;

function dedupeLinks(links) {
  const seen = new Set();
  const out = [];
  for (const link of links) {
    if (!link || !link.url) continue;
    const key = String(link.url).split("#")[0];
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ url: link.url, title: (link.title || "").trim() });
  }
  return out;
}

function errorText(error) {
  return error && error.message ? error.message : String(error);
}

try {
  const task = await taskSpace(INPUT.spaceId);
  page = await task.newPage();
  console.log("DIGSIGHT_PROGRESS " + JSON.stringify({ message: "打开 WorkBuddy" }));
  await page.goto("https://www.workbuddy.cn/app", { timeout: 120000 });
  await page.waitForTimeout(5000);

  let state = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    body: (document.body.innerText || "").slice(0, 3000),
    hasEditor: !!document.querySelector('div[data-slate-editor="true"], [contenteditable="true"]'),
    hasConversation: !!document.querySelector(".cr-agent")
  }));

  if (new URL(state.url).origin === ORIGIN && (!state.hasEditor || state.hasConversation)) {
    try {
      await page.click('text="新建任务"');
      await page.waitForTimeout(3000);
      state = await page.evaluate(() => ({
        url: location.href,
        title: document.title,
        body: (document.body.innerText || "").slice(0, 3000),
        hasEditor: !!document.querySelector('div[data-slate-editor="true"], [contenteditable="true"]'),
        hasConversation: !!document.querySelector(".cr-agent")
      }));
    } catch (error) {
      result.notes.push("打开新建任务失败：" + errorText(error));
    }
  }

  if (new URL(state.url).origin !== ORIGIN || !state.hasEditor || state.hasConversation) {
    const portal = /maccauth|ruijie|上网认证|WiFi认证|网络认证/i.test(state.url + " " + state.body);
    const needs = portal || /登录|扫码|sign in|log in|验证/i.test(state.body);
    result.status = needs ? "needs_user_action" : "failed";
    result.needsUserAction = needs;
    result.error = portal
      ? "网络需要先完成 WiFi 认证（检测到网络认证页）"
      : needs
        ? "WorkBuddy 未登录或需要人机验证"
        : "找不到 WorkBuddy 的新任务输入框";
    throw new Error(result.error);
  }

  await page.waitForSelector('div[data-slate-editor="true"], [contenteditable="true"]', { timeout: 30000 });
  console.log("DIGSIGHT_PROGRESS " + JSON.stringify({ message: "写入调研任务书" }));
  if (await page.evaluate(() => location.origin) !== ORIGIN) throw new Error("WorkBuddy 已跳转到其他网站，停止提交");
  await page.click('div[data-slate-editor="true"], [contenteditable="true"]');
  if (await page.evaluate(() => location.origin) !== ORIGIN) throw new Error("WorkBuddy 已跳转到其他网站，停止提交");
  await page.keyboard.insertText(INPUT.prompt);
  await page.waitForTimeout(700);

  const deepClicked = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll("button")].filter((button) =>
      (button.textContent || "").trim() === "深度研究" && button.offsetParent !== null
    );
    if (!buttons.length) return false;
    buttons[0].click();
    return true;
  });
  result.notes.push("deepResearchToken=" + deepClicked);
  await page.waitForTimeout(900);

  await page.waitForFunction(() => {
    const button = document.querySelector('button[aria-label="发送"]');
    return button && !button.disabled;
  }, undefined, { timeout: 20000 });

  console.log("DIGSIGHT_PROGRESS " + JSON.stringify({ message: "提交 WorkBuddy 深度研究任务" }));
  if (await page.evaluate(() => location.origin) !== ORIGIN) throw new Error("WorkBuddy 已跳转到其他网站，停止提交");
  await page.click('button[aria-label="发送"]');

  const deadline = Date.now() + INPUT.timeoutMs;
  let lastText = "";
  let stableSince = 0;
  let sawConversation = false;
  let completed = false;

  while (Date.now() < deadline) {
    await page.waitForTimeout(4000);
    const current = await page.evaluate(() => {
      const agents = [...document.querySelectorAll(".cr-agent")];
      const last = agents[agents.length - 1];
      let answer = "";
      if (last) {
        answer = [...last.querySelectorAll('[data-markdown-content="true"]')].map((el) => el.innerText || "").join("\\n\\n");
        if (!answer) {
          const clone = last.cloneNode(true);
          clone.querySelectorAll(".cr-process-row, .conversation-finished-footer, .artifact-slot-panel, .cr-agent__header").forEach((el) => el.remove());
          answer = clone.innerText || "";
        }
      }
      const footer = !!(last && last.querySelector('[data-testid="conversation-finished-footer"]'));
      const body = document.body.innerText || "";
      const tail = body.slice(-3000);
      return {
        url: location.href,
        answer,
        chars: answer.length,
        footer,
        agentCount: agents.length,
        processing: /(正在|执行中|思考中|生成中|处理中|等待云端响应)/.test(tail),
        needsAction: /(登录已过期|请登录|积分不足|额度不足|请选择工作空间|人机验证|扫码登录)/.test(tail)
      };
    });

    if (current.url.indexOf("/conversation/") >= 0) sawConversation = true;
    if (current.needsAction) {
      result.status = "needs_user_action";
      result.needsUserAction = true;
      result.error = "WorkBuddy 需要人工处理（登录/积分/工作空间/验证）";
      break;
    }
    if (current.chars > 0) {
      if (current.answer !== lastText) {
        lastText = current.answer;
        stableSince = Date.now();
        console.log("DIGSIGHT_PROGRESS " + JSON.stringify({ message: "WorkBuddy 正在执行", data: { chars: current.chars } }));
      }
      if ((current.footer && Date.now() - stableSince > 3000) || (!current.processing && Date.now() - stableSince > 15000)) {
        completed = true;
        break;
      }
    }
  }

  if (!sawConversation) throw new Error("未能进入 WorkBuddy 任务会话");
  if (!lastText.trim()) throw new Error("WorkBuddy 回答为空");
  if (!completed) result.notes.push("未检测到明确完成信号，按最后一次稳定内容保存");

  const data = await page.evaluate((captureHtml) => {
    const agents = [...document.querySelectorAll(".cr-agent")];
    const last = agents[agents.length - 1];
    let answer = "";
    if (last) {
      answer = [...last.querySelectorAll('[data-markdown-content="true"]')].map((el) => el.innerText || "").join("\\n\\n");
      if (!answer) {
        const clone = last.cloneNode(true);
        clone.querySelectorAll(".cr-process-row, .conversation-finished-footer, .artifact-slot-panel, .cr-agent__header").forEach((el) => el.remove());
        answer = clone.innerText || "";
      }
    }
    const links = last
      ? [...last.querySelectorAll('a[href^="http"]')].map((anchor) => ({ url: anchor.href, title: (anchor.textContent || "").trim() }))
      : [];
    return {
      answerText: answer,
      answerHtml: captureHtml && last ? last.innerHTML : "",
      links,
      pageTitle: document.title,
      url: location.href
    };
  }, Boolean(INPUT.rawHtmlPath));
  if (new URL(data.url).origin !== ORIGIN) throw new Error("WorkBuddy 已跳转到其他网站，停止采集");

  result.answerText = data.answerText || lastText;
  result.answerMarkdown = result.answerText;
  result.citations = dedupeLinks(data.links);
  result.pageTitle = data.pageTitle;
  result.conversationUrl = data.url.split(/[?#]/, 1)[0];

  const sourceLabel = await page.evaluate(() => {
    const agents = [...document.querySelectorAll(".cr-agent")];
    const last = agents[agents.length - 1];
    const buttons = last ? [...last.querySelectorAll("button")] : [...document.querySelectorAll("button")];
    const button = buttons.find((el) =>
      /^\\d+个来源$/.test((el.getAttribute("aria-label") || "").trim())
    );
    if (!button) return null;
    button.click();
    return button.getAttribute("aria-label");
  });
  if (sourceLabel) {
    await page.waitForTimeout(1500);
    result.searchCount = Number((sourceLabel.match(/\\d+/) || [0])[0]) || undefined;
    result.searchSources = await page.evaluate(() =>
      [...document.querySelectorAll(".sources-panel__item")].map((item) => ({
        site: item.querySelector(".sources-panel__item-site") ? item.querySelector(".sources-panel__item-site").textContent.trim() : "",
        title: item.querySelector(".sources-panel__item-title") ? item.querySelector(".sources-panel__item-title").textContent.trim() : "",
        snippet: item.querySelector(".sources-panel__item-snippet") ? item.querySelector(".sources-panel__item-snippet").textContent.trim() : ""
      }))
    );
    try {
      await page.click('loc=css:.sources-panel button[aria-label="关闭"]');
    } catch {}
  }

  if (INPUT.rawHtmlPath) {
    try {
      await fs.writeFile(INPUT.rawHtmlPath, data.answerHtml || "", { encoding: "utf8", mode: 0o600 });
      result.rawHtmlPath = INPUT.rawHtmlPath;
    } catch (error) {
      result.notes.push("写 raw html 失败：" + errorText(error));
    }
  }
  result.status = "ok";
} catch (error) {
  result.error = result.error || errorText(error);
  if (page && INPUT.failureShotPath && !result.needsUserAction) {
    try {
      if (await page.evaluate(() => location.origin) === ORIGIN) {
        await page.screenshot({ path: INPUT.failureShotPath });
        result.failureScreenshot = INPUT.failureShotPath;
      }
    } catch {}
  }
} finally {
  result.finishedAt = new Date().toISOString();
  result.durationMs = Date.now() - t0;
  try {
    await fs.writeFile(INPUT.resultPath, JSON.stringify(result, null, 2), { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    console.error("DIGSIGHT_RESULT_WRITE_FAILED " + errorText(error));
  }
  if (page && !result.needsUserAction) {
    try { await page.close(); } catch {}
  }
  console.log("DIGSIGHT_RESULT " + JSON.stringify({
    engine: "workbuddy",
    status: result.status,
    answerChars: result.answerText.length,
    citations: result.citations.length,
    sources: result.searchSources.length,
    error: result.error
  }));
}`;
}
