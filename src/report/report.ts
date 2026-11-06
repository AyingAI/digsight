import { readFileSync } from "node:fs";
import { marked, Renderer } from "marked";
import { createHash } from "node:crypto";
const PRINT_SCRIPT = 'document.querySelector(".print-button").addEventListener("click", () => window.print());';
export const REPORT_SCRIPT_HASH = `sha256-${createHash("sha256").update(PRINT_SCRIPT).digest("base64")}`;
// Permit only the exact historical print handler; never enable arbitrary inline JS.
export const LEGACY_PRINT_HASH = `sha256-${createHash("sha256").update("window.print()").digest("base64")}`;

export function safeReportHref(href: string): boolean {
  if (/^(?:https?:\/\/)/i.test(href)) {
    return isPublicResearchUrl(href);
  }
  return /^#[-\w]+$/.test(href) || /^(materials|analysis|citations)\/[a-zA-Z0-9_./-]+\.(md|json|png)$/.test(href) && !href.includes("..");
}
import type {
  Analysis,
  CitationCheck,
  Conclusion,
  Decomposition,
  Material,
  RunMeta,
  SourceRef,
  SubQuestion,
} from "../types.ts";
import { domainOf, isPublicResearchUrl, normalizeSourceTitle, truncate } from "../util.ts";
import { engineLabel } from "../materials.ts";

export interface ReadingEdition {
  answer: string;
  rationale: string;
  questions: { id: string; question: string; answer: string; paragraphs: string[] }[];
  next: string[];
  note?: string;
  provenance?: string;
}

export interface ReportInput {
  edition?: ReadingEdition;
  meta: RunMeta;
  decomposition: Decomposition;
  analyses: Analysis[];
  conclusion: Conclusion;
  materials: Material[];
  citations: CitationCheck[];
}

export function buildReportFile(input: ReportInput): string {
  return `# ${reportTitle(input)}\n\n${buildReportBody(input).replace(/^(### 第(\d+)问　)/gm, (_, heading, n) => `<a id="q${n}"></a>\n\n${heading}`)}\n`;
}

// Editorial revisions only affect the reading copy. Keep the original run, analyses and events intact.
function readingCopy(input: ReportInput): ReadingEdition {
  const { conclusion, decomposition, analyses, materials } = input;
  if (input.edition) {
    const e = input.edition;
    const hasText = (v: unknown): v is string => typeof v === "string" && Boolean(v.trim());
    if (!hasText(e.answer) || !hasText(e.rationale) || !Array.isArray(e.next) || !e.next.every(hasText) ||
        !Array.isArray(e.questions) || e.questions.length !== decomposition.subQuestions.length ||
        !decomposition.subQuestions.every((q, i) => {
          const r = e.questions[i];
          return r?.id === q.id && hasText(r.question) && hasText(r.answer) && Array.isArray(r.paragraphs) && r.paragraphs.length && r.paragraphs.every(hasText);
        })) throw new Error("复核稿缺少总判断或分题答案，未生成报告。");
    return e;
  }
  const byId = new Map(analyses.map(a => [a.subQuestionId, a]));
  const sourceNames = new Map(collectSources(materials).map(source => [source.url, source.title]));
  const missing = decomposition.subQuestions.filter(q => {
    const a = byId.get(q.id);
    return !a || a.analysisUnavailable || a.gaps?.some(g => g.startsWith("自动分析失败"));
  });
  return {
    answer: conclusion.finalConclusion,
    rationale: conclusion.decisionReason || "",
    questions: decomposition.subQuestions.map(q => {
      const a = byId.get(q.id);
      if (!a || missing.includes(q)) return { id:q.id, question:q.question, answer:"本题分析未完成，暂不作判断。", paragraphs:[materials.some(m => m.subQuestionId === q.id && m.status === "ok") ? "已经采集到材料，但没有完成核对。这不代表研究对象缺乏证据。" : "本次没有取得足够的可用材料。"] };
      const facts = a.keyEvidence.slice(0, 3).map(e => {
        const sources = e.sources.map(source => /^https?:\/\//i.test(source)
          ? `[${escapeBrackets(sourceNames.get(source) || domainOf(source))}](<${source}>)` : source);
        return [e.evidence, sources.length ? `（${sources.join("；")}）` : ""].join("");
      });
      return {id:q.id, question:a.readingQuestion || q.question, answer:a.conclusion, paragraphs:[
        ...facts, a.reasoning === "模型未返回推理过程。" ? "" : a.reasoning,
        ...a.conflicts.slice(0,1).map(c => `${c.issue}：${c.resolution}`), ...a.gaps.slice(0,1)
      ].filter(Boolean)};
    }),
    next:conclusion.recommendations,
    note:missing.length ? `本次有 ${missing.length} 道题未完成分析，以上总判断只能作为阶段性判断。` : undefined,
  };
}

export function buildReportBody(input: ReportInput): string {
  const r = readingCopy(input);
  const parts = ["## 总判断", r.answer, r.rationale, r.note ? `> ${r.note}` : ""];
  if (r.questions.length) {
    parts.push("## 核心问题与结论", r.questions.map((q,i) =>
      `${i+1}. **[${escapeBrackets(q.question)}](#q${i+1})**　${q.answer}`).join("\n"));
    r.questions.forEach((q,i) => parts.push(`### 第${i+1}问　${q.question}`, `**${q.answer}**`, ...q.paragraphs));
  }
  if (r.next.length) parts.push("## 下一步", r.next.map((step,i) => `${i+1}. ${step}`).join("\n"));
  const { meta, decomposition, materials, citations } = input;
  parts.push("## 原始材料与核查记录", `最初的问题：${meta.question}`);
  if (r.provenance) parts.push(r.provenance);
  parts.push(decomposition.subQuestions.map((q,i) => {
    const raw = materials.filter(m => m.subQuestionId === q.id).map(m =>
      `[${engineLabel(m.engine)}${m.status === "ok" ? "" : "（未成功）"}](materials/${subQuestionFolder(q.id,i)}/${m.engine}.md)`);
    return `- 第 ${i+1} 问：${[...raw, ...(input.analyses.some(a => a.subQuestionId === q.id) ? [`[原始分析](analysis/${q.id}.md)`] : [])].join(" · ") || "无已保存材料"}`;
  }).join("\n"));
  if (citations.length) parts.push(`原运行抽查了 ${citations.length} 个引用链接，其中 ${citations.filter(c => c.ok).length} 个当时可打开。页面可访问不等于其中的说法已经证实。[查看逐条记录](citations/index.json)`);
  return parts.filter(p => p.trim()).join("\n\n");
}

function reportTitle(input: ReportInput): string {
  const title = (input.meta.title || input.decomposition.title || input.conclusion.title || "").trim();
  if (title) return title;
  return truncate(input.meta.question.replace(/\s+/g, " "), 42);
}

function escapeBrackets(text: string): string {
  return text.replace(/\[/g, "(").replace(/\]/g, ")");
}

function collectSources(materials: Material[]): SourceRef[] {
  const seen = new Set<string>();
  const out: SourceRef[] = [];
  for (const material of materials) {
    for (const source of [...material.citations, ...material.searchSources]) {
      const key = source.url || `${source.site ?? ""}|${source.title ?? ""}`;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({ ...source, title: normalizeSourceTitle(source.title, source.url) });
    }
  }
  return out;
}

export function subQuestionFolder(id: string, index: number): string {
  const number = index >= 0 ? index + 1 : Number(id.replace(/\D/g, "")) || 1;
  return `q${String(number).padStart(2, "0")}`;
}

/* -------------------------------------------------------------------------- */
/* HTML                                                                       */
/* -------------------------------------------------------------------------- */

export function buildReportHtml(input: ReportInput): string {
  const title = reportTitle(input);
  const repeatsWorkbenchTitle = title === (input.decomposition.title || input.meta.title || input.conclusion.title);
  const bodyMarkdown = buildReportBody(input);
  const renderer = new Renderer();
  // Research material is untrusted input. Drop raw HTML tokens so a source or
  // model output cannot inject scripts into the report page.
  renderer.html = () => "";
  renderer.link = function ({ href, tokens }) {
    const label = this.parser.parseInline(tokens);
    return safeReportHref(href)
      ? `<a ${href.startsWith("#") ? "" : 'target="_blank" rel="noopener noreferrer" '}href="${escapeHtml(href)}">${label}</a>`
      : label;
  };
  // Do not fetch tracking images embedded in model/source Markdown.
  const chapters: string[] = [];
  renderer.heading = function ({ tokens, depth }) {
    const body = this.parser.parseInline(tokens);
    if (depth === 2) {
      const id = `chapter-${chapters.length + 1}`;
      chapters.push(`<a href="#${id}">${body.replace(/<[^>]*>/g, "")}</a>`);
      const role = body === "总判断" ? ' class="judgment-title"' : body === "核心问题与结论" ? ' class="questions-title"' : "";
      return `<h2 id="${id}"${role}>${body}</h2>\n`;
    }
    const section = depth === 3 && /^第(\d+)问　/.exec(body);
    if (section) return `<h3 id="q${section[1]}"><span class="question-number">第${section[1]}问</span> ${body.slice(section[0].length)}</h3>\n`;
    return `<h${depth}>${body}</h${depth}>\n`;
  };
  renderer.image = ({ text }) => escapeHtml(text);
  let html = marked.parse(bodyMarkdown, { gfm: true, breaks: false, renderer }) as string;
  // The HTML index sets each question on its own line. Keep the full-width
  // question/answer separator in the text export only.
  html = html.replace(/(<li><strong><a href="#q\d+">[^\n]*?<\/a><\/strong>)　/g, "$1 ");
  // Let wide evidence tables scroll horizontally on small screens instead of
  // expanding the document.
  html = html.replace(/<table>/g, '<div class="table-wrap"><table>').replace(/<\/table>/g, "</table></div>");
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src '${REPORT_SCRIPT_HASH}'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · DIGSIGHT</title>
<style>
${REPORT_CSS}
</style>
</head>
<body>
<header class="cover">
  <div class="topline"><span class="brand"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"><path d="m3 7 9-5 9 5-9 5-9-5Zm0 5 9 5 9-5m-18 5 9 5 9-5"/></svg>Digsight</span><time>${escapeHtml((input.meta.finishedAt || input.meta.createdAt).slice(0,10))}</time><button class="print-button" type="button">打印 / 保存 PDF</button></div>
  <h1${repeatsWorkbenchTitle ? "" : ' id="reading-start"'}>${escapeHtml(title)}</h1>
  <div class="reading-tools"${repeatsWorkbenchTitle ? ' id="reading-start"' : ""}><details class="contents"><summary>报告目录</summary><nav aria-label="报告目录">${chapters.join("")}</nav></details></div>
</header>
<main class="report">${html}</main>
<script>${PRINT_SCRIPT}</script>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Embed the stylesheet so offline copies and the sandboxed preview render identically.
const REPORT_CSS = readFileSync(new URL("./reading.css", import.meta.url), "utf8");
