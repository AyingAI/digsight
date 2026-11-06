#!/usr/bin/env node
/**
 * Rebuild report.md / report.html from a run's persisted artifacts.
 * Useful after changing the report template or fixing a run's metadata.
 */
import path from "node:path";
import { readFile } from "node:fs/promises";
import { DEFAULT_RUNS_DIR } from "./config.ts";
import { buildReportFile, buildReportHtml, type ReadingEdition, type ReportInput } from "./report/report.ts";
import { listRuns, readRunJson, resolveRunFile, runDirectory } from "./store.ts";
import type { Analysis, CitationCheck, Conclusion, Decomposition, Material, RunMeta } from "./types.ts";
import { writeText } from "./util.ts";

const runId = process.argv[2];
const runsDir = path.resolve(process.env.DIGSIGHT_RUNS_DIR || DEFAULT_RUNS_DIR);

if (!runId) {
  const runs = await listRuns(runsDir);
  console.log("用法：node src/rebuild-report.ts <runId>");
  console.log("\n可用运行：");
  for (const run of runs.slice(0, 20)) {
    console.log(`  ${run.id}  [${run.status}]  ${run.title || run.question}`);
  }
  process.exit(1);
}

const dir = await runDirectory(runId, runsDir);
if (!dir) {
  console.error("运行 ID 无效或目录不存在。");
  process.exit(1);
}
const [meta, decomposition, analyses, conclusion, materials, citations, reviewFile] = await Promise.all([
  readRunJson<RunMeta>(dir, "run.json"),
  readRunJson<Decomposition>(dir, "decomposition.json"),
  readRunJson<Analysis[]>(dir, "analysis/index.json"),
  readRunJson<Conclusion>(dir, "conclusion.json"),
  readRunJson<Material[]>(dir, "materials/index.json"),
  readRunJson<CitationCheck[]>(dir, "citations/index.json"),
  resolveRunFile(dir, "editorial-review.json"),
]);
const review = reviewFile ? await readFile(reviewFile, "utf8") : undefined;

if (meta?.id !== runId || !decomposition || !analyses || !conclusion) {
  console.error(`缺少必要产物，无法重建：${dir}`);
  process.exit(1);
}

const input: ReportInput = {
  edition: review === undefined ? undefined : JSON.parse(review) as ReadingEdition,
  meta,
  decomposition,
  analyses,
  conclusion,
  materials: materials ?? [],
  citations: citations ?? [],
};
const reportMd = buildReportFile(input);
const reportHtml = buildReportHtml(input);
await Promise.all([
  writeText(path.join(dir, "report.md"), reportMd),
  writeText(path.join(dir, "report.html"), reportHtml),
]);
console.log(`已重建：\n  ${path.join(dir, "report.md")}\n  ${path.join(dir, "report.html")}`);
