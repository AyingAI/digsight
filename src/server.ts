#!/usr/bin/env node
import http from "node:http";
import { promises as fs, createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_RUNS_DIR, defaultOptions, inspectEnvironment, normalizeOptions, resolveModel } from "./config.ts";
import { HttpError, readJsonBody, validateRequest } from "./http-safety.ts";
import { REPORT_SCRIPT_HASH, LEGACY_PRINT_HASH } from "./report/report.ts";
import { runPipeline } from "./pipeline.ts";
import { AUTO_QUESTION_LIMIT, MANUAL_QUESTION_LIMIT, questionCount } from "./research-plan.ts";
import { RunContext } from "./run-context.ts";
import { listRuns, loadRun, readRunEvents, resolveRunFile, setHistoryVisibility } from "./store.ts";
import type { EngineName, ProgressEvent, RunOptions, ThinkingLevel } from "./types.ts";
import { ensureDir } from "./util.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(__dirname, "..", "web");
const RUNS_DIR = path.resolve(process.env.DIGSIGHT_RUNS_DIR || DEFAULT_RUNS_DIR);
const PORT = Number(process.env.DIGSIGHT_PORT || 4317);
const HOST = process.env.DIGSIGHT_HOST || "127.0.0.1";

const active = new Map<string, RunContext>();
let starting = false;
let shuttingDown = false;
const running = new Set<Promise<unknown>>();
let environmentCache: { expires: number; value: ReturnType<typeof inspectEnvironment> } | undefined;
let environmentPending = false;
function environment(refresh = false) {
  if (!environmentCache || (!environmentPending && (refresh || environmentCache.expires < Date.now()))) {
    environmentPending = true;
    const value = inspectEnvironment().finally(() => { environmentPending = false; });
    environmentCache = { expires: Date.now() + 15_000, value };
  }
  return environmentCache.value;
}

function effectiveMeta(meta: import("./types.ts").RunMeta) {
  if (!active.has(meta.id) && ["running", "queued"].includes(meta.status)) {
    return { ...meta, status: "failed" as const, error: "服务已中断，当前任务未在执行。已保存的材料仍可查看；可使用原问题重新调研。" };
  }
  return meta;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".ico": "image/x-icon",
};

async function main(): Promise<void> {
  if (!["127.0.0.1", "localhost", "::1"].includes(HOST)) {
    throw new Error("DIGSIGHT 可操作已登录的浏览器，仅支持本机监听。不要将此服务暴露到公网。");
  }
  await ensureDir(RUNS_DIR);
  const server = http.createServer({ requestTimeout: 20_000, headersTimeout: 10_000 }, (req, res) => {
    handle(req, res).catch((error) => {
      if (!(error instanceof HttpError)) console.error("[server]", error);
      if (!res.headersSent) sendJson(res, error instanceof HttpError ? error.status : 500, {
        error: error instanceof HttpError ? error.message : "服务暂时无法处理请求，请重试或查看终端日志。",
      });
      else res.end();
    });
  });

  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      console.error(`端口 ${PORT} 已被占用。请关闭占用进程，或用 DIGSIGHT_PORT=其他端口 启动。`);
    } else {
      console.error(error);
    }
    process.exit(1);
  });

  server.listen(PORT, HOST === "localhost" ? "127.0.0.1" : HOST, () => {
    console.log("");
    console.log("  DIGSIGHT · 多智能体深度调研");
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : PORT;
    console.log(`  UI        http://${HOST === "::1" ? "[::1]" : HOST}:${port}`);
    console.log(`  运行目录  ${RUNS_DIR}`);
    console.log("");
  });

  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\n正在关闭，停止采集并保存状态…");
    for (const ctx of active.values()) ctx.cancel();
    server.close();
    const deadline = setTimeout(() => process.exit(0), 15_000);
    void Promise.allSettled([...running]).then(() => { clearTimeout(deadline); process.exit(0); });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  validateRequest(req);
  if (shuttingDown) throw new HttpError(503, "服务正在关闭，请稍后重试。");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'");
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  let pathname: string;
  try { pathname = decodeURIComponent(url.pathname); }
  catch { throw new HttpError(400, "URL 编码不正确。"); }

  if (req.method === "GET" && pathname === "/api/setup") {
    const defaults = normalizeOptions({ question: "" });
    return sendJson(res, 200, { ...await environment(url.searchParams.get("refresh") === "1"), questionLimits: { auto: AUTO_QUESTION_LIMIT, manual: MANUAL_QUESTION_LIMIT }, defaults: {
      subQuestionCount: defaults.subQuestionCount, concurrency: defaults.concurrency,
      maxCitations: defaults.maxCitations, verifyCitations: defaults.verifyCitations, keepSpace: defaults.keepSpace,
    } });
  }

  if (req.method === "GET" && pathname === "/api/health") {
    return sendJson(res, 200, { ok: true, activeRuns: active.size });
  }

  if (pathname === "/api/runs" && req.method === "GET") {
    const metas = await listRuns(RUNS_DIR, true);
    for (const [id, ctx] of active) {
      const index = metas.findIndex((m) => m.id === id);
      if (index >= 0) metas[index] = ctx.meta;
      else metas.unshift(ctx.meta);
    }
    metas.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    return sendJson(res, 200, { runs: metas.map(effectiveMeta), activeRunId: active.keys().next().value || null });
  }

  if (pathname === "/api/runs" && req.method === "POST") {
    if (starting || active.size > 0) {
      return sendJson(res, 409, {
        error: "已有调研正在创建或执行，请稍候。",
        activeRunId: active.keys().next().value,
      });
    }
    // Reserve before the first await, including body parsing and directory creation.
    starting = true;
    try {
      const body = await readJsonBody(req);
      if (typeof body.question !== "string") throw new HttpError(400, "请填写调研问题。");
      const question = body.question.trim();
      if (question.length < 6) return sendJson(res, 400, { error: "调研问题至少需要 6 个字符。" });
      if (question.length > 4000) return sendJson(res, 400, { error: "调研问题过长（最多 4000 字符）。" });

      const engines = parseEngines(body.engines);
      if (!engines.length) return sendJson(res, 400, { error: "至少选择一个调研引擎。" });
      const defaults = defaultOptions();
      let count;
      try { count = questionCount(body.subQuestionCount === undefined ? defaults.subQuestionCount : body.subQuestionCount); }
      catch (error) { throw new HttpError(400, (error as Error).message); }
      const options = normalizeOptions({
        question,
        engines,
        subQuestionCount: count,
        concurrency: numberOr(body.concurrency, defaults.concurrency),
        model: typeof body.model === "string" && body.model.trim() ? body.model.trim() : undefined,
        thinkingLevel: body.thinkingLevel === undefined ? defaults.thinkingLevel : parseThinking(body.thinkingLevel),
        verifyCitations: typeof body.verifyCitations === "boolean" ? body.verifyCitations : defaults.verifyCitations,
        maxCitations: numberOr(body.maxCitations, defaults.maxCitations),
        keepSpace: typeof body.keepSpace === "boolean" ? body.keepSpace : defaults.keepSpace,
        runsDir: RUNS_DIR,
      });

      // Fail before creating a run or opening any website. Pin the actual model for this run.
      try { options.model = (await resolveModel(options.model)).label; }
      catch (error) { throw new HttpError(422, (error as Error).message); }
      const setup = await environment();
      if (!setup.browser.ok) throw new HttpError(422, setup.browser.error || "请先安装 Ego Lite。");
      if (shuttingDown) throw new HttpError(503, "服务正在关闭。");
      const ctx = await RunContext.create(options, RUNS_DIR);
      active.set(ctx.id, ctx);
      const execution = runPipeline(ctx)
        .catch(async (error) => {
          if (ctx.meta.status === "running" || ctx.meta.status === "queued") {
            ctx.emit({
              type: "error",
              phase: ctx.meta.phase,
              status: "failed",
              message: (error as Error).message || String(error),
            });
            await ctx.setStatus("failed", ctx.meta.phase, (error as Error).message || String(error));
          }
        })
        .finally(() => {
          active.delete(ctx.id);
          running.delete(execution);
        });
      running.add(execution);
      void execution.catch((error) => console.error("[pipeline]", error));

      return sendJson(res, 202, { runId: ctx.id, meta: ctx.meta });
    } finally {
      starting = false;
    }
  }

  const runMatch = pathname.match(/^\/api\/runs\/([^/]+)$/);
  if (runMatch && req.method === "GET") {
    const runId = runMatch[1]!;
    const summary = await loadRun(runId, RUNS_DIR);
    if (!summary) return sendJson(res, 404, { error: "run not found" });
    const ctx = active.get(runId);
    summary.meta = ctx ? ctx.meta : effectiveMeta(summary.meta);
    return sendJson(res, 200, { ...summary, active: Boolean(ctx), reportUrl: `/runs/${runId}/report` });
  }

  const historyMatch = pathname.match(/^\/api\/runs\/([^/]+)\/history$/);
  if (historyMatch && req.method === "POST") {
    const id = historyMatch[1]!;
    const { visible } = await readJsonBody(req);
    if (typeof visible !== "boolean") throw new HttpError(400, "历史记录操作无效。");
    if (active.has(id)) throw new HttpError(409, "调研结束后可以删除这条记录。");
    if (!await setHistoryVisibility(id, RUNS_DIR, visible)) throw new HttpError(404, "未找到历史记录。");
    return sendJson(res, 200, { visible });
  }

  const eventsMatch = pathname.match(/^\/api\/runs\/([^/]+)\/events$/);
  if (eventsMatch && req.method === "GET") {
    const runId = eventsMatch[1]!;
    return streamEvents(runId, req, res);
  }

  const cancelMatch = pathname.match(/^\/api\/runs\/([^/]+)\/cancel$/);
  if (cancelMatch && req.method === "POST") {
    const ctx = active.get(cancelMatch[1]!);
    if (!ctx) return sendJson(res, 409, { error: "该运行当前不在执行中。" });
    ctx.cancel();
    return sendJson(res, 200, { ok: true });
  }

  const fileMatch = pathname.match(/^\/api\/runs\/([^/]+)\/file$/);
  if (fileMatch && req.method === "GET") {
    const runId = fileMatch[1]!;
    const ctx = active.get(runId);
    const summary = ctx ? undefined : await loadRun(runId, RUNS_DIR);
    const runDir = ctx?.dir ?? (summary ? path.join(RUNS_DIR, runId) : undefined);
    if (!runDir) return sendJson(res, 404, { error: "run not found" });
    const rel = url.searchParams.get("path") || "";
    const file = await resolveRunFile(runDir, rel);
    if (!file) return sendJson(res, 404, { error: "file not found" });
    return sendFile(res, file, url.searchParams.get("download") === "1", rel === "report.html" ? "report" : "artifact");
  }

  const reportMatch = pathname.match(/^\/runs\/([^/]+)\/report$/);
  if (reportMatch && req.method === "GET") {
    const runId = reportMatch[1]!;
    const ctx = active.get(runId);
    const summary = ctx ? undefined : await loadRun(runId, RUNS_DIR);
    const runDir = ctx?.dir ?? (summary ? path.join(RUNS_DIR, runId) : undefined);
    if (!runDir) return sendText(res, 404, "运行不存在");
    const file = await resolveRunFile(runDir, "report.html");
    if (!file) return sendText(res, 404, "报告尚未生成");
    return sendFile(res, file, false, "report");
  }

  const runStaticMatch = pathname.match(/^\/runs\/([^/]+)\/(.+)$/);
  if (runStaticMatch && req.method === "GET") {
    const runId = runStaticMatch[1]!;
    const rel = runStaticMatch[2]!;
    const ctx = active.get(runId);
    const summary = ctx ? undefined : await loadRun(runId, RUNS_DIR);
    const runDir = ctx?.dir ?? (summary ? path.join(RUNS_DIR, runId) : undefined);
    if (!runDir) return sendText(res, 404, "运行不存在");
    const file = await resolveRunFile(runDir, rel);
    if (!file) return sendText(res, 404, "文件不存在");
    return sendFile(res, file, false, rel === "report.html" ? "report" : "artifact");
  }

  if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
    return sendFile(res, path.join(WEB_DIR, "index.html"));
  }
  if (req.method === "GET" && ["/app.css", "/app.js"].includes(pathname)) {
    return sendFile(res, path.join(WEB_DIR, pathname.slice(1)));
  }

  sendText(res, 404, "Not found");
}

async function streamEvents(runId: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "X-Content-Type-Options": "nosniff",
  });
  res.write("retry: 3000\n\n");

  const lastId = Number(req.headers["last-event-id"] || 0);
  const writeEvent = (event: ProgressEvent) => {
    if (Number.isFinite(lastId) && event.seq <= lastId) return;
    // Bound a slow client's queued data rather than retaining an unlimited buffer.
    if (res.writableLength > 1024 * 1024) { res.destroy(); return; }
    res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
  };

  const ctx = active.get(runId);
  if (ctx) {
    for (const event of ctx.events) writeEvent(event);
    if (["completed", "failed", "cancelled"].includes(ctx.meta.status)) {
      res.end("event: end\ndata: {}\n\n");
      return;
    }
    const unsubscribe = ctx.subscribe((event) => {
      try {
        writeEvent(event);
        if (event.type === "run" && ["ok", "failed", "cancelled"].includes(event.status || "")) {
          res.write("event: end\ndata: {}\n\n");
          res.end();
        }
      } catch {
        unsubscribe();
      }
    });
    const heartbeat = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        clearInterval(heartbeat);
      }
    }, 15000);
    res.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
    return;
  }

  const summary = await loadRun(runId, RUNS_DIR);
  if (!summary) {
    res.write(`event: end\ndata: ${JSON.stringify({ error: "run not found" })}\n\n`);
    res.end();
    return;
  }
  const events = await readRunEvents(path.join(RUNS_DIR, runId), 5000);
  for (const event of events) writeEvent(event as ProgressEvent);
  res.write(`event: end\ndata: {}\n\n`);
  res.end();
}

function sendJson(res: http.ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

function sendText(res: http.ServerResponse, status: number, text: string): void {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(text);
}

async function sendFile(
  res: http.ServerResponse, file: string, download = false, kind: "ui" | "report" | "artifact" = "ui",
): Promise<void> {
  const ext = path.extname(file).toLowerCase();
  const activeArtifact = kind === "artifact" && [".html", ".svg", ".js", ".css", ".xml"].includes(ext);
  const contentType = activeArtifact ? CONTENT_TYPES[".txt"] : CONTENT_TYPES[ext] || "application/octet-stream";
  const stat = await fs.stat(file);
  if (kind === "report") {
    res.setHeader("Content-Security-Policy", `sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads; default-src 'none'; script-src '${REPORT_SCRIPT_HASH}' 'unsafe-hashes' '${LEGACY_PRINT_HASH}'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`);
  }
  if (download || kind === "artifact" && ext === ".pdf") {
    const name = path.basename(file) + (activeArtifact ? ".txt" : "");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  }
  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": stat.size,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  const stream = createReadStream(file);
  stream.on("error", () => res.destroy());
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}

function parseEngines(value: unknown): EngineName[] {
  if (Array.isArray(value)) return value.filter((item): item is EngineName => item === "deepseek" || item === "workbuddy");
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter((item): item is EngineName => item === "deepseek" || item === "workbuddy");
  }
  return ["deepseek", "workbuddy"];
}

function parseThinking(value: unknown): ThinkingLevel {
  const valid: ThinkingLevel[] = ["off", "low", "medium", "high"];
  return valid.includes(value as ThinkingLevel) ? (value as ThinkingLevel) : "high";
}

function numberOr(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

await main();
