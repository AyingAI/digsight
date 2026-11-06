#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { checkEgoBrowser, defaultOptions, normalizeEngines, normalizeOptions, resolveModel } from "./config.ts";
import { createTaskSpace, finishTaskSpace, preflightBrowsers } from "./browser/ego.ts";
import { runPipeline } from "./pipeline.ts";
import { questionCount } from "./research-plan.ts";
import { RunContext } from "./run-context.ts";
import type { ProgressEvent, RunOptions, ThinkingLevel } from "./types.ts";
import { formatDuration, stripAnsi } from "./util.ts";

const ANSI = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
  dim: (s: string) => (ANSI ? `\u001b[2m${s}\u001b[0m` : s),
  bold: (s: string) => (ANSI ? `\u001b[1m${s}\u001b[0m` : s),
  green: (s: string) => (ANSI ? `\u001b[32m${s}\u001b[0m` : s),
  red: (s: string) => (ANSI ? `\u001b[31m${s}\u001b[0m` : s),
  yellow: (s: string) => (ANSI ? `\u001b[33m${s}\u001b[0m` : s),
  cyan: (s: string) => (ANSI ? `\u001b[36m${s}\u001b[0m` : s),
  magenta: (s: string) => (ANSI ? `\u001b[35m${s}\u001b[0m` : s),
};

const HELP = `
DIGSIGHT · 多智能体深度调研

用法：
  digsight "你的调研问题" [选项]
  digsight serve [--port 4317]

调研流程：
  1. 按证据需要自动拆题，或按指定数量开展调研
  2. 通过 ego 浏览器驱动 DeepSeek / WorkBuddy 分别调研，每个子问题独立会话
  3. 原始材料、引用、来源卡片全部落盘
  4. 主调研 Agent 交叉核查、逐题推理，再合成最终结论
  5. 生成 Markdown + HTML 调研报告

选项：
  --subquestions <n>     auto 自动拆解 1–8 题（默认），或指定 1–12 题
  --engines <list>       调研引擎，逗号分隔：deepseek,workbuddy（默认两者）
  --concurrency <n>      同时调研的子问题数（默认 2，范围 1-6）
  --model <provider/id>  综合模型（默认沿用 pi 设置；指定不可用模型时明确报错）
  --thinking <level>     off | low | medium | high（默认 high）
  --timeout <minutes>    每个网页 Agent 的单次调研超时（默认 15 分钟）
  --max-citations <n>    最多核查多少个引用 URL（默认 10，0 表示不核查）
  --no-verify            关闭引用 URL 核查
  --raw-html             保存第三方页面回答的原始 HTML（默认关闭）
  --no-raw-html          不保存原始 HTML
  --keep-space           结束后保留 ego 浏览器任务空间，便于检查
  --runs-dir <path>      运行目录（默认 ./runs）
  --json                 结束时输出机器可读摘要
  --open                 完成后自动打开 HTML 报告
  --help                 显示帮助

命令：
  digsight doctor        检查模型、ego-browser、DeepSeek / WorkBuddy 登录状态
  digsight serve         启动本地 Web 界面

示例：
  digsight "2026 年 AI 编程工具的市场格局会如何演变？" --subquestions 5
  digsight "某私募基金的业绩是否可持续？" --engines deepseek,workbuddy --concurrency 2
  digsight serve --port 4317
  digsight doctor
`.trim();

interface CliOptions {
  command: "run" | "serve" | "help" | "doctor";
  question: string;
  run: Partial<RunOptions>;
  port: number;
  json: boolean;
  open: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const out: CliOptions = {
    command: "run",
    question: "",
    run: {},
    port: Number(process.env.DIGSIGHT_PORT || 4317),
    json: false,
    open: false,
  };
  if (argv[0] === "doctor") {
    out.command = "doctor";
    return out;
  }
  if (argv[0] === "serve") {
    out.command = "serve";
    for (let i = 1; i < argv.length; i++) {
      if (argv[i] === "--port" && argv[i + 1]) out.port = Number(argv[++i]);
    }
    return out;
  }
  if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) {
    out.command = "help";
    return out;
  }

  const questionParts: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`选项 ${arg} 缺少值`);
      return value;
    };
    switch (arg) {
      case "--subquestions":
        out.run.subQuestionCount = questionCount(next());
        break;
      case "--engines":
        out.run.engines = normalizeEngines(next());
        break;
      case "--concurrency":
        out.run.concurrency = Number(next());
        break;
      case "--model":
        out.run.model = next();
        break;
      case "--thinking":
        out.run.thinkingLevel = next() as ThinkingLevel;
        break;
      case "--timeout":
        out.run.researchTimeoutMs = Number(next()) * 60_000;
        break;
      case "--max-citations":
        out.run.maxCitations = Number(next());
        break;
      case "--no-verify":
        out.run.verifyCitations = false;
        break;
      case "--verify":
        out.run.verifyCitations = true;
        break;
      case "--no-raw-html":
        out.run.saveRawHtml = false;
        break;
      case "--raw-html":
        out.run.saveRawHtml = true;
        break;
      case "--keep-space":
        out.run.keepSpace = true;
        break;
      case "--runs-dir":
        out.run.runsDir = path.resolve(next());
        break;
      case "--json":
        out.json = true;
        break;
      case "--open":
        out.open = true;
        break;
      default:
        if (arg.startsWith("--")) throw new Error(`未知选项：${arg}`);
        questionParts.push(arg);
    }
  }
  out.question = questionParts.join(" ").trim();
  return out;
}

function printEvent(event: ProgressEvent, progressAt: Map<string, number>): void {
  if (event.type === "run" && event.status === "info") return;
  const time = new Date(event.ts).toLocaleTimeString("zh-CN", { hour12: false });
  const prefix = c.dim(time);
  const q = event.subQuestionId ? c.cyan(event.subQuestionId) : "";
  const engine = event.engine ? c.magenta(engineLabel(event.engine)) : "";
  const tag = [q, engine].filter(Boolean).join(" · ");

  if (event.status === "progress") {
    const key = `${event.type}:${event.subQuestionId ?? ""}:${event.engine ?? ""}:${event.phase ?? ""}`;
    const last = progressAt.get(key) ?? 0;
    const important = /完成|失败|超时|错误|需要|不可用/.test(event.message);
    if (!important && Date.now() - last < 12_000) return;
    progressAt.set(key, Date.now());
    console.log(`${prefix}  ${c.dim("·")} ${tag ? `${tag} ` : ""}${c.dim(truncate(event.message, 120))}`);
    return;
  }

  if (event.type === "phase") {
    if (event.status === "start") console.log(`\n${prefix} ${c.bold("▶")} ${c.bold(event.message)}`);
    else if (event.status === "ok") console.log(`${prefix} ${c.green("✓")} ${event.message}`);
    else if (event.status === "failed") console.log(`${prefix} ${c.red("✗")} ${event.message}`);
    else if (event.status === "skip") console.log(`${prefix} ${c.dim("○")} ${c.dim(event.message)}`);
    return;
  }

  if (event.type === "engine") {
    if (event.status === "start") console.log(`${prefix}   ${c.dim("└")} ${tag} ${c.dim(event.message)}`);
    else if (event.status === "ok") {
      const duration = (event.data as { durationMs?: number } | undefined)?.durationMs;
      console.log(
        `${prefix}   ${c.green("✓")} ${tag} ${event.message}${duration ? c.dim(` (${formatDuration(duration)})`) : ""}`,
      );
    } else if (event.status === "failed" || event.status === "timeout") {
      console.log(`${prefix}   ${c.red("✗")} ${tag} ${event.message}`);
    }
    return;
  }

  if (event.type === "subquestion") {
    if (event.status === "start") console.log(`\n${prefix} ${c.yellow("◆")} ${event.message}`);
    else if (event.status === "ok") console.log(`${prefix} ${c.green("◇")} ${event.message}`);
    return;
  }

  if (event.type === "agent") {
    if (event.status === "start") console.log(`${prefix} ${c.dim("◇")} ${tag ? `${tag} ` : ""}${event.message}`);
    else if (event.status === "ok") console.log(`${prefix} ${c.green("◇")} ${tag ? `${tag} ` : ""}${event.message}`);
    else if (event.status === "failed") console.log(`${prefix} ${c.yellow("◇")} ${event.message}`);
    else if (event.status === "info") console.log(`${prefix} ${c.dim("◇")} ${event.message}`);
    else console.log(`${prefix} ${c.dim("·")} ${event.message}`);
    return;
  }

  if (event.type === "citation") {
    return;
  }

  if (event.type === "report") {
    console.log(`${prefix} ${c.green("✓")} ${event.message}`);
    return;
  }

  if (event.type === "error") {
    console.log(`${prefix} ${c.red("✗")} ${event.message}`);
    return;
  }

  if (event.type === "log") {
    console.log(`${prefix} ${c.dim("·")} ${c.dim(event.message)}`);
    return;
  }

  if (event.type === "run" && (event.status === "ok" || event.status === "failed" || event.status === "cancelled")) {
    return;
  }

  console.log(`${prefix} ${event.message}`);
}

function engineLabel(engine: string): string {
  return engine === "deepseek" ? "DeepSeek" : engine === "workbuddy" ? "WorkBuddy" : engine;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

async function runCommand(parsed: CliOptions): Promise<number> {
  if (!parsed.question) {
    console.log(HELP);
    return 1;
  }
  if (parsed.question.length < 6) {
    console.error(c.red("调研问题太短，请给出一个完整的问题。"));
    return 1;
  }

  const options = normalizeOptions({ ...defaultOptions(parsed.run), question: parsed.question });
  console.log(c.bold("\nDIGSIGHT · 多智能体深度调研"));
  console.log(c.dim(`问题：${options.question}`));
  console.log(
    c.dim(
      `引擎：${options.engines.map(engineLabel).join(" / ")}　子问题：${options.subQuestionCount === "auto" ? "自动" : options.subQuestionCount}　并行：${options.concurrency}　引用核查：${
        options.verifyCitations ? options.maxCitations : "关闭"
      }`,
    ),
  );

  const ctx = await RunContext.create(options);
  console.log(c.dim(`运行目录：${ctx.dir}\n`));
  const progressAt = new Map<string, number>();
  const unsubscribe = ctx.subscribe((event) => printEvent(event, progressAt));

  let sigint = 0;
  const onSigint = () => {
    sigint++;
    if (sigint === 1) {
      console.log(c.yellow("\n收到中断，正在取消当前运行（再按一次强制退出）…"));
      ctx.cancel();
    } else {
      process.exit(130);
    }
  };
  process.on("SIGINT", onSigint);

  try {
    const result = await runPipeline(ctx);
    console.log(c.bold(c.green("\n调研完成")));
    console.log(c.bold(`\n最终判断：${verdictZh(result.conclusion.verdict)}　置信度：${Math.round(result.conclusion.confidence * 100)}%`));
    console.log(`\n${stripAnsi(result.conclusion.finalConclusion)}\n`);
    console.log(c.dim("报告："));
    console.log(`  Markdown  ${result.reportMdPath}`);
    console.log(`  HTML      ${result.reportHtmlPath}`);
    console.log(`  运行目录  ${ctx.dir}`);
    if (parsed.open) openFile(result.reportHtmlPath);
    if (parsed.json) {
      console.log(
        JSON.stringify(
          {
            runId: ctx.id,
            status: ctx.meta.status,
            verdict: result.conclusion.verdict,
            confidence: result.conclusion.confidence,
            conclusion: result.conclusion.finalConclusion,
            reportMd: result.reportMdPath,
            reportHtml: result.reportHtmlPath,
            runDir: ctx.dir,
          },
          null,
          2,
        ),
      );
    }
    return 0;
  } catch (error) {
    console.log(c.red(`\n运行失败：${(error as Error).message}`));
    console.log(c.dim(`运行目录：${ctx.dir}`));
    if (parsed.json) {
      console.log(JSON.stringify({ runId: ctx.id, status: ctx.meta.status, error: (error as Error).message }, null, 2));
    }
    return 1;
  } finally {
    process.off("SIGINT", onSigint);
    unsubscribe();
    await ctx.flushEvents().catch(() => {});
  }
}

function verdictZh(verdict: string): string {
  return verdict === "supported"
    ? "支持"
    : verdict === "partially_supported"
      ? "部分支持"
      : verdict === "refuted"
        ? "不支持"
        : "证据不足";
}

function openFile(file: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(command, [file], { detached: true, stdio: "ignore" }).unref();
  } catch {
    // best effort
  }
}

async function runDoctor(): Promise<number> {
  console.log(c.bold("\nDIGSIGHT · 环境诊断\n"));
  let ok = true;
  try {
    const model = await resolveModel();
    console.log(`${c.green("✓")} 模型凭据已检测到：${model.label}（未调用 API 验证额度或连通性）`);
  } catch (error) {
    ok = false;
    console.log(`${c.red("✗")} 模型不可用：${(error as Error).message}`);
  }

  const ego = await checkEgoBrowser();
  if (ego.ok) console.log(`${c.green("✓")} ego-browser：${ego.version || "ok"}`);
  else {
    ok = false;
    console.log(`${c.red("✗")} ego-browser 不可用：${ego.error}`);
    return 1;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const doctorDir = path.join(defaultOptions().runsDir, `_doctor-${stamp}`);
  console.log(c.dim(`\n诊断目录：${doctorDir}`));
  let spaceId: number | undefined;
  try {
    spaceId = await createTaskSpace(`digsight-doctor-${stamp}`);
    console.log(`${c.green("✓")} 已创建浏览器任务空间（spaceId=${spaceId}）`);
    const preflight = await preflightBrowsers({
      spaceId,
      engines: ["deepseek", "workbuddy"],
      shotsDir: path.join(doctorDir, "preflight"),
      resultPath: path.join(doctorDir, "preflight.json"),
      onProgress: (engine, message) => console.log(c.dim(`  ${engineLabel(engine)}：${message}`)),
    });
    for (const engine of ["deepseek", "workbuddy"] as const) {
      const result = preflight.engines[engine];
      if (result?.ok) console.log(`${c.green("✓")} ${engineLabel(engine)} 已登录且页面结构可用`);
      else {
        ok = false;
        console.log(`${c.red("✗")} ${engineLabel(engine)} 不可用：${result?.error || "未知原因"}`);
      }
    }
    if (preflight.keepPages) {
      console.log(c.yellow("\n相关页面已保留在 ego 浏览器中。完成登录/验证后，重新运行 digsight doctor 即可。"));
    } else if (spaceId) {
      await finishTaskSpace(spaceId);
      console.log(c.dim("\n诊断用浏览器任务空间已关闭。"));
    }
  } catch (error) {
    ok = false;
    console.log(`${c.red("✗")} 浏览器诊断失败：${(error as Error).message}`);
    if (spaceId) {
      try {
        await finishTaskSpace(spaceId);
      } catch {
        // ignore
      }
    }
  }
  console.log(ok ? c.green("\n环境检查通过，可以开始调研。\n") : c.yellow("\n环境检查未通过，请按上面的提示处理后重试。\n"));
  return ok ? 0 : 1;
}

async function main(): Promise<void> {
  let parsed: CliOptions;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(c.red((error as Error).message));
    console.log(HELP);
    process.exit(1);
  }

  if (parsed.command === "help") {
    console.log(HELP);
    return;
  }
  if (parsed.command === "serve") {
    process.env.DIGSIGHT_PORT = String(parsed.port);
    await import("./server.ts");
    return;
  }
  if (parsed.command === "doctor") {
    process.exitCode = await runDoctor();
    return;
  }
  const code = await runCommand(parsed);
  process.exitCode = code;
}

await main();
