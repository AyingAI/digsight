import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import dns from "node:dns/promises";
import { EventEmitter } from "node:events";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import { selectModel, normalizeOptions, piAgentDir } from "../src/config.ts";
import { classifyDomain, extractJson, isPublicResearchUrl, pMap, redactWebSecrets, writeJson } from "../src/util.ts";
import { checkCitation, isPublicAddress } from "../src/citations.ts";
import { loadRun, resolveRunFile, validRunId } from "../src/store.ts";
import { RunContext } from "../src/run-context.ts";
import { questionCount, validatePlan } from "../src/research-plan.ts";
import type { Decomposition } from "../src/types.ts";
import { runEgoScript } from "../src/browser/ego.ts";
import { buildReportHtml, buildReportFile, safeReportHref, REPORT_SCRIPT_HASH } from "../src/report/report.ts";
import { PiAgent, EmptyAgentResponse } from "../src/agents/session.ts";
import type { ReportInput } from "../src/report/report.ts";

const models = [
  { provider: "opencode-go", id: "deepseek-v4-pro" },
  { provider: "opencode-go", id: "deepseek-v4.1-flash" },
  { provider: "other", id: "small" },
];

test("model selection follows explicit > env > pi; flash is the unconfigured preference", () => {
  assert.equal(selectModel(models, { piDefault: "opencode-go/deepseek-v4.1-flash" }).model.id, "deepseek-v4.1-flash");
  assert.equal(selectModel(models, { requested: "other/small", environment: "wrong", piDefault: "wrong" }).source, "requested");
  assert.equal(selectModel(models, { environment: "other/small", piDefault: "wrong" }).source, "environment");
  assert.equal(selectModel(models, {}).source, "preferred");
  assert.equal(selectModel([models[2]!], {}).source, "only-available");
});

test("missing, ambiguous and unauthorized choices never silently fall back", () => {
  assert.throws(() => selectModel(models, { requested: "missing/model" }), /不会自动切换/);
  assert.throws(() => selectModel(models, { piDefault: "missing/model" }), /不会自动切换/);
  assert.throws(() => selectModel([], {}), /尚未连接/);
  assert.throws(() => selectModel([models[0]!, models[2]!], {}), /多个可用模型/);
  assert.throws(() => selectModel([...models, { provider: "duplicate", id: "small" }], { requested: "small" }), /多个提供商/);
});

test("configuration respects the SDK directory variable and normalizes boundaries", () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = "/tmp/digsight-config-test";
    assert.equal(piAgentDir(), "/tmp/digsight-config-test");
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
  const options = normalizeOptions({ question: "  test  ", maxCitations: 0, concurrency: 100, subQuestionCount: 12 });
  assert.equal(options.question, "test");
  assert.equal(options.maxCitations, 0);
  assert.equal(options.concurrency, 6);
  assert.equal(options.subQuestionCount, 12);
});

test("planning honors the chosen scope before collection and requires a separate title", () => {
  const question = "我想判断该不该在新的方向上投入";
  const plan = (count: number) => ({
    title: "新方向的投入价值",
    subQuestions: Array.from({ length: count }, (_, i) => ({ question: `核查第 ${i+1} 项假设` })),
  }) as Decomposition;
  for (const input of ["auto", 1, 8, 9, 12]) assert.equal(questionCount(input), input);
  for (const input of [0, -2, 1.5, 13, null, ""]) assert.throws(() => questionCount(input));
  for (const count of [1, 8]) assert.doesNotThrow(() => validatePlan(plan(count), "auto", question));
  for (const count of [9, 12]) assert.doesNotThrow(() => validatePlan(plan(count), count, question));
  assert.throws(() => validatePlan(plan(9), "auto", question));
  assert.throws(() => validatePlan(plan(6), 12, question));
  assert.throws(() => validatePlan({ ...plan(1), title: question }, 1, question));
  assert.throws(() => validatePlan({ ...plan(1), title: question.slice(0, 5) + "…" }, 1, question));
  const repeated = plan(2);
  repeated.subQuestions[1]!.question = repeated.subQuestions[0]!.question + "？";
  assert.throws(() => validatePlan(repeated, 2, question));
});

test("JSON repair preserves commas and brackets inside evidence strings", () => {
  assert.deepEqual(extractJson('```json\n{"text":"literal ,} and ,]", "list":[1,2,],}\n```'), { text: "literal ,} and ,]", list: [1, 2] });
  assert.deepEqual(extractJson('{"text":"comma ,}"}'), { text: "comma ,}" });
  assert.throws(() => extractJson("not json"), /no JSON/);
});

test("citation navigation excludes local, IP-literal, credential-bearing and non-web URLs", () => {
  for (const url of ["file:///etc/passwd", "http://localhost/a", "http://127.1/a", "http://[::1]/a", "https://10.0.0.1/a", "https://example.com:4317", "https://user:pass@example.com/", "https://intranet.local/a", "https://home.arpa/a", "https://example.com/?startIntentToken=fake", "https://example.com/?X-Amz-Signature=fake"]) {
    assert.equal(isPublicResearchUrl(url), false, url);
  }
  assert.equal(isPublicResearchUrl("https://www.nobelprize.org/prizes/chemistry/2024/summary/"), true);
  assert.equal(redactWebSecrets("a https://example.com/?page=1&amp;token=fake b"), "a [已隐藏含认证信息的链接] b");
  assert.equal(redactWebSecrets("https://example.com/?page=1"), "https://example.com/?page=1");
});

test("citations pin a public address, reject private DNS and re-check redirects without sending credentials", async (t) => {
  for (const address of ["127.0.0.1", "100.64.0.1", "169.254.169.254", "192.168.0.1", "::1", "::ffff:127.0.0.1", "fd00::1", "64:ff9b::7f00:1", "2002:7f00:1::1"]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress("93.184.215.14"), true);
  assert.equal(isPublicAddress("2606:4700::1111"), true);
  const requests: string[] = [];
  t.mock.method(dns, "lookup", async (hostname: string) => {
    const publicAnswer = { address: "93.184.215.14", family: 4 };
    return hostname === "private.example" ? [publicAnswer, { address: "127.0.0.1", family: 4 }] : [publicAnswer];
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  t.mock.method(http, "get", (url: URL, options: http.RequestOptions, onResponse: (response: unknown) => void) => {
    requests.push(url.href);
    assert.equal(options.agent, false);
    assert.ok(!Object.keys(options.headers ?? {}).some((key) => /cookie|authorization|referer/i.test(key)));
    options.lookup?.(url.hostname, { family: 4 }, (error, address) => {
      assert.equal(error, null);
      assert.equal(address, "93.184.215.14");
    });
    const redirect = url.pathname === "/redirect";
    const response = Readable.from([Buffer.from("<html><head><title>Public page</title></head><body>Evidence<script>hidden</script></body></html>")]);
    queueMicrotask(() => onResponse(Object.assign(response, {
      statusCode: redirect ? 302 : 200,
      headers: redirect ? { location: "http://private.example/secret" } : { "content-type": "text/html; charset=utf-8" },
    })));
    return new EventEmitter();
  });
  const signal = AbortSignal.timeout(1000);
  const result = await checkCitation("http://public.example/article", signal);
  assert.equal(result.ok, true);
  assert.equal(result.title, "Public page");
  assert.equal(result.excerpt, "Evidence");
  assert.match((await checkCitation("http://public.example/redirect", signal)).error!, /非公开地址/);
  assert.match((await checkCitation("http://private.example/secret", signal)).error!, /非公开地址/);
  assert.deepEqual(requests, ["http://public.example/article", "http://public.example/redirect"]);
});

test("source tiers use domain boundaries and do not treat any .org as authoritative", () => {
  assert.equal(classifyDomain("https://reuters.com/a"), "medium");
  assert.equal(classifyDomain("https://fake-reuters.com/a"), "unknown");
  assert.equal(classifyDomain("https://evilnature.com/a"), "unknown");
  assert.equal(classifyDomain("https://example.org/a"), "unknown");
  assert.equal(classifyDomain("https://www.stats.gov.cn/a"), "high");
});

test("file serving rejects traversal, unsafe IDs and symlink escapes", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "digsight-files-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, "safe-run");
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, "ok.md"), "ok");
  await fs.writeFile(path.join(root, "secret.txt"), "secret");
  await fs.symlink(path.join(root, "secret.txt"), path.join(dir, "escape.txt"));
  assert.equal(await resolveRunFile(dir, "../secret.txt"), undefined);
  assert.equal(await resolveRunFile(dir, "..\\secret.txt"), undefined);
  assert.equal(await resolveRunFile(dir, "escape.txt"), undefined);
  assert.equal(await resolveRunFile(dir, "ok.md"), await fs.realpath(path.join(dir, "ok.md")));
  assert.equal(validRunId(".."), false);
  assert.equal(await loadRun("../secret", root), undefined);
});

test("metadata concurrent updates are serialized and atomic", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "digsight-meta-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const ctx = await RunContext.create(normalizeOptions({ question: "testing metadata", runsDir: root }));
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(ctx.dir)).mode & 0o077, 0);
    assert.equal((await fs.stat(ctx.path("question.md"))).mode & 0o077, 0);
    assert.equal((await fs.stat(ctx.path("events.ndjson"))).mode & 0o077, 0);
  }
  await Promise.all(Array.from({ length: 20 }, (_, i) => ctx.update({ phase: String(i) })));
  await ctx.flushEvents();
  assert.equal(JSON.parse(await fs.readFile(ctx.path("run.json"), "utf8")).phase, "19");
  await writeJson(ctx.path("atomic.json"), { value: true });
  assert.ok(!(await fs.readdir(ctx.dir)).some((file) => file.endsWith(".tmp")));
});

test("concurrent work settles before cleanup after a rejection", async () => {
  let settled = false;
  await assert.rejects(pMap([0, 1], 2, async (item) => {
    if (!item) throw new Error("failed");
    await new Promise((resolve) => setTimeout(resolve, 30));
    settled = true;
  }), /failed/);
  assert.equal(settled, true);
});

test("pre-aborted browser jobs never spawn a process", async () => {
  await assert.rejects(runEgoScript("throw new Error('must not execute')", { signal: AbortSignal.abort() }), /cancelled/);
});

test("browser cancellation terminates a running CLI without consuming model credits", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX CLI fixture");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "digsight-ego-test-"));
  const previousPath = process.env.PATH;
  const key = "DIGSIGHT_TEST_SECRET";
  t.after(async () => { process.env.PATH = previousPath; delete process.env[key]; await fs.rm(root, { recursive: true, force: true }); });
  await fs.writeFile(path.join(root, "ego-browser"), `#!${process.execPath}\nif (process.env.${key}) process.exit(5); process.stdin.resume(); console.log('started'); setInterval(() => {}, 1000);\n`, { mode: 0o700 });
  process.env.PATH = `${root}:${previousPath}`;
  process.env[key] = "test-only";
  const controller = new AbortController();
  const started = Date.now();
  await assert.rejects(runEgoScript("unused", {
    signal: controller.signal,
    onStdoutLine: () => controller.abort(),
    timeoutMs: 2000,
  }), /cancelled/);
  assert.ok(Date.now() - started < 5000);
});

export function reportFixture(): ReportInput {
  const question = "测试报告是否安全";
  const options = normalizeOptions({ question });
  return {
    meta: { id: "test-run", question, status: "completed", phase: "done", options, createdAt: new Date().toISOString(), counts: { subQuestions: 0, engines: 0, materialsOk: 0, materialsFailed: 0, citationsChecked: 0, citationsOk: 0 } },
    decomposition: { questionRestated: question, thesisToTest: "test", reasoningApproach: "test", subQuestions: [] },
    materials: [], analyses: [], citations: [],
    conclusion: { title: "Safe report", finalConclusion: '[attack](javascript:alert%281%29) <img src=x onerror=alert(1)> ![tracking](https://tracker.example/pixel)', verdict: "inconclusive", confidence: 0, executiveSummary: [], logicChain: [], keyFindings: [], counterEvidence: [], uncertainties: [], recommendations: [], methodologyNote: "test" },
  };
}

test("report rejects executable URLs, raw HTML and remote tracking images", () => {
  assert.equal(safeReportHref("javascript:alert(1)"), false);
  assert.equal(safeReportHref("data:text/html,hi"), false);
  assert.equal(safeReportHref("//evil.example/a"), false);
  assert.equal(safeReportHref("https://example.com/a"), true);
  assert.equal(safeReportHref("materials/q01/deepseek.md"), true);
  assert.equal(safeReportHref("materials/../../auth.json"), false);
  const html = buildReportHtml(reportFixture());
  assert.ok(!html.includes('href="javascript:'));
  assert.ok(!html.includes("<img"));
  assert.ok(!html.includes("onerror="));
  assert.ok(!html.includes("onclick="));
  assert.match(REPORT_SCRIPT_HASH, /^sha256-/);
});

test("reading copy covers every question, distinguishes missing analysis, and preserves original wording", () => {
  const input = reportFixture();
  input.conclusion.finalConclusion = "值得小范围试用。";
  input.conclusion.decisionReason = "用户愿意试，还没有续费记录。";
  input.decomposition.subQuestions = ["客户会买吗？", "客户会续费吗？"].map((question, i) => ({
    id: `q${i+1}`, question, logicRole: "", whyItMatters: "", evidenceNeeded: [], researchBrief: "", successCriteria: "",
  }));
  input.analyses = [{subQuestionId:"q1", question:"客户会买吗？", readingQuestion:"有没有付费订单？", conclusion:"已有付费订单。", verdict:"supported", confidence:0.8, engineAgreement:"high", keyEvidence:[
    {claim:"有订单",evidence:"试用团队公开了首单。",sources:["https://example.org/orders"],strength:"strong",corroboration:"both"}
  ],conflicts:[],gaps:[],reasoning:"首单无法证明续费。"}];
  const html = buildReportHtml(input);
  assert.match(html, /id="q2"/);
  assert.match(html, /本题分析未完成/);
  assert.match(html, /href="https:\/\/example.org\/orders"/);
  assert.ok(html.indexOf(input.conclusion.finalConclusion) < html.indexOf("有没有付费订单？"));
  assert.match(buildReportFile(input), /<a id="q1"><\/a>/);
  input.edition = {answer:"复核结论",rationale:"理由",questions:[],next:[]};
  assert.throws(() => buildReportFile(input), /复核稿缺少/);
  input.edition.questions = input.decomposition.subQuestions.map(q => ({id:q.id,question:q.question,answer:"复核答案",paragraphs:["原文记录"]}));
  assert.match(buildReportHtml(input), /复核答案/);
  assert.equal(input.analyses[0]?.conclusion, "已有付费订单。");
});

test("empty replies retry within the conversation; cancellation and exhausted retries propagate", async () => {
  let calls = 0;
  const agent = Object.create(PiAgent.prototype) as PiAgent;
  agent.ask = async () => { if (++calls === 1) throw new EmptyAgentResponse(); return '{"ok":true}'; };
  assert.deepEqual(await agent.structured("提问"), {ok:true});
  assert.equal(calls, 2);
  calls = 0;
  agent.ask = async () => { calls++; throw new EmptyAgentResponse("无正文"); };
  await assert.rejects(agent.structured("提问", {retries:1}), /无正文/);
  assert.equal(calls, 2);
  calls = 0;
  agent.ask = async () => { calls++; throw new Error("cancelled"); };
  await assert.rejects(agent.structured("提问"), /cancelled/);
  assert.equal(calls, 1);
});
