import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { normalizeOptions } from "../src/config.ts";

// A private fixture server: no access to the developer's auth or run directory.
test("HTTP setup, history, validation, stream replay and local-origin protections", { timeout: 30_000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "digsight-http-"));
  const runs = path.join(root, "runs");
  const run = path.join(runs, "test-run");
  const agent = path.join(root, "agent");
  await fs.mkdir(run, { recursive: true });
  await fs.mkdir(agent);
  await fs.writeFile(path.join(agent, "settings.json"), JSON.stringify({ defaultProvider: "missing", defaultModel: "missing" }));
  await fs.writeFile(path.join(run, "run.json"), JSON.stringify({
    id: "test-run", question: "这是测试运行记录", status: "running", phase: "research", createdAt: new Date().toISOString(),
    options: normalizeOptions({ question: "这是测试运行记录", runsDir: runs }), counts: {},
  }));
  await fs.writeFile(path.join(run, "events.ndjson"), [1, 2, 3].map((seq) => JSON.stringify({ seq, runId: "test-run", type: "log", message: "event" })).join("\n"));
  await fs.writeFile(path.join(run, "report.md"), "# Report");
  await fs.writeFile(path.join(run, "report.html"), "<h1>Report</h1>");
  await fs.writeFile(path.join(run, "capture.raw.html"), "<script>alert(1)</script>");
  await fs.writeFile(path.join(run, "capture.js"), "throw new Error('untrusted')");
  await fs.writeFile(path.join(run, ".env"), "private");
  await fs.mkdir(path.join(run, "analysis"));
  await fs.writeFile(path.join(run, "analysis", "report.html"), "<script>alert(1)</script>");
  await fs.writeFile(path.join(root, "secret.txt"), "private");
  await fs.writeFile(path.join(root, "secret.json"), JSON.stringify({ private: true }));
  await fs.symlink(path.join(root, "secret.txt"), path.join(run, "escape.txt"));
  await fs.symlink(path.join(root, "secret.json"), path.join(run, "analysis", "index.json"));
  const child = spawn(process.execPath, ["src/server.ts"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", DIGSIGHT_PORT: "0", DIGSIGHT_HOST: "127.0.0.1", DIGSIGHT_RUNS_DIR: runs },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stderr.on("data", (data) => { output += data; });
  t.after(async () => {
    if (child.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
    await fs.rm(root, { recursive: true, force: true });
  });
  const base = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server startup timeout: ${output}`)), 12_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.stdout.on("data", (data) => {
      output += data;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
  });
  const post = (body: string, headers = {}) => fetch(`${base}/api/runs`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });

  await t.test("setup exposes model metadata, not credentials; missing key is actionable", async () => {
    const response = await fetch(`${base}/api/setup`);
    assert.equal(response.status, 200);
    const setup = await response.json();
    assert.equal(setup.skillsRequired, false);
    assert.equal(setup.loginChecked, false);
    assert.equal(setup.model.ok, false);
    assert.deepEqual(setup.questionLimits, { auto: 8, manual: 12 });
    assert.equal(setup.defaults.subQuestionCount, "auto");
    assert.match(setup.model.error, /login/);
    assert.ok(!/apiKey|baseUrl|auth\.json|authorization/i.test(JSON.stringify(setup)));
  });
  await t.test("interrupted history is not presented as an active job", async () => {
    const list = await (await fetch(`${base}/api/runs`)).json();
    assert.equal(list.activeRunId, null);
    assert.equal(list.runs[0].status, "failed");
    const detail = await (await fetch(`${base}/api/runs/test-run`)).json();
    assert.equal(detail.active, false);
    assert.match(detail.meta.error, /中断/);
    assert.equal(detail.analyses, undefined);
  });
  await t.test("bad JSON and input fail with 4xx and no run is created", async () => {
    assert.equal((await post("{")).status, 400);
    assert.equal((await post("null")).status, 400);
    assert.equal((await post("[]")).status, 400);
    assert.equal((await post('{"question":"短"}')).status, 400);
    assert.equal((await post(JSON.stringify({ question: "这是正常问题", engines: [] }))).status, 400);
    assert.equal((await post(JSON.stringify({ question: "这是正常问题", subQuestionCount: 13 }))).status, 400);
    // Valid scopes get past validation to model lookup, without starting paid work.
    for (const subQuestionCount of [12, "auto"]) {
      assert.equal((await post(JSON.stringify({ question: "这是正常问题", subQuestionCount, model: "missing/model" }))).status, 422);
    }
    assert.equal((await post(JSON.stringify({ question: "这是正常问题", model: "missing/model" }))).status, 422);
    assert.equal((await post(JSON.stringify({ question: "x".repeat(70_000) }))).status, 413);
    assert.equal((await fs.readdir(runs)).length, 1);
  });
  await t.test("creation lock covers slow request bodies", async () => {
    const request = http.request(`${base}/api/runs`, { method: "POST", headers: { "content-type": "application/json", "transfer-encoding": "chunked" } });
    const done = new Promise<void>((resolve) => { request.on("response", (res) => { res.resume(); res.on("end", resolve); }); request.on("error", () => resolve()); });
    request.write('{"question":');
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal((await post('{"question":"这是另一个问题"}')).status, 409);
    request.end('"短"}');
    await done;
  });
  await t.test("blocks cross-site requests, rebinding hosts and non-JSON writes", async () => {
    assert.equal((await post("{}", { origin: "https://evil.example" })).status, 403);
    const hostStatus = await new Promise<number | undefined>((resolve, reject) => {
      http.get(`${base}/api/health`, { headers: { host: "evil.example:4317" } }, (res) => { res.resume(); resolve(res.statusCode); }).on("error", reject);
    });
    assert.equal(hostStatus, 403);
    assert.equal((await post("{}", { "content-type": "text/plain" })).status, 415);
  });
  await t.test("SSE resumes after Last-Event-ID", async () => {
    const response = await fetch(`${base}/api/runs/test-run/events`, { headers: { "Last-Event-ID": "2" } });
    const text = await response.text();
    assert.ok(!text.includes("id: 1\n"));
    assert.ok(!text.includes("id: 2\n"));
    assert.ok(text.includes("id: 3\n"));
    assert.ok(text.includes("event: end"));
  });
  await t.test("raw HTML stays text, exports download, paths stay confined", async () => {
    const raw = await fetch(`${base}/api/runs/test-run/file?path=capture.raw.html`);
    assert.match(raw.headers.get("content-type")!, /text\/plain/);
    const rawDownload = await fetch(`${base}/api/runs/test-run/file?path=capture.raw.html&download=1`);
    assert.match(rawDownload.headers.get("content-disposition")!, /capture\.raw\.html\.txt/);
    const script = await fetch(`${base}/runs/test-run/capture.js`);
    assert.match(script.headers.get("content-type")!, /text\/plain/);
    const nestedReport = await fetch(`${base}/runs/test-run/analysis/report.html`);
    assert.match(nestedReport.headers.get("content-type")!, /text\/plain/);
    const report = await fetch(`${base}/runs/test-run/report`);
    assert.match(report.headers.get("content-type")!, /text\/html/);
    assert.match(report.headers.get("content-security-policy")!, /sandbox allow-scripts/);
    const md = await fetch(`${base}/api/runs/test-run/file?path=report.md&download=1`);
    assert.match(md.headers.get("content-disposition")!, /attachment/);
    assert.equal(md.headers.get("cache-control"), "no-store");
    assert.equal((await fetch(`${base}/api/runs/test-run/file?path=escape.txt`)).status, 404);
    assert.equal((await fetch(`${base}/api/runs/test-run/file?path=.env`)).status, 404);
    assert.equal((await fetch(`${base}/api/runs/test-run/file?path=..%2F..%2Fsecret.txt`)).status, 404);
    assert.equal((await fetch(`${base}/api/runs/test-run%2F..%2F..`)).status, 404);
    assert.equal((await fetch(`${base}/%zz`)).status, 400);
  });
  await t.test("removing history preserves reports, supports undo, and refuses unknown directories", async () => {
    const visibility = (id: string, visible: boolean) => fetch(`${base}/api/runs/${id}/history`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ visible }),
    });
    const history = async () => (await (await fetch(`${base}/api/runs`)).json()).runs;
    assert.equal((await visibility("test-run", false)).status, 200);
    assert.equal((await history()).length, 0);
    assert.equal(await (await fetch(`${base}/api/runs/test-run/file?path=report.md`)).text(), "# Report");
    assert.equal((await visibility("test-run", true)).status, 200);
    assert.equal((await history())[0].id, "test-run");
    assert.equal((await visibility("unknown", false)).status, 404);
    await fs.symlink(root, path.join(runs, "outside"));
    assert.equal((await visibility("outside", false)).status, 404);
  });
});
