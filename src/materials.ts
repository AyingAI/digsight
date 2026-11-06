import path from "node:path";
import type { Material, SubQuestion } from "./types.ts";
import { dedupeSources, ensureDir, redactWebSecrets, writeJson, writeText } from "./util.ts";

export async function persistMaterial(input: {
  material: Material;
  dir: string;
  runDir: string;
  subQuestion: SubQuestion;
}): Promise<Material> {
  const { material, dir, runDir, subQuestion } = input;
  const normalized: Material = {
    ...material,
    status: material.status ?? "failed",
    citations: cleanSources(material.citations ?? []),
    searchSources: cleanSources(material.searchSources ?? []),
    answerText: redactWebSecrets(material.answerText ?? ""),
    answerMarkdown: redactWebSecrets(material.answerMarkdown || material.answerText || ""),
    rawText: material.rawText ? redactWebSecrets(material.rawText).slice(0, 200_000) : "",
    pageTitle: material.pageTitle ? redactWebSecrets(material.pageTitle) : undefined,
    conversationUrl: material.conversationUrl ? redactWebSecrets(material.conversationUrl) : undefined,
    error: material.error ? redactWebSecrets(material.error) : undefined,
    notes: (material.notes ?? []).map(redactWebSecrets),
  };
  if (normalized.rawHtmlPath) {
    normalized.rawHtmlPath = toRunRelative(normalized.rawHtmlPath, runDir);
  }
  if (normalized.failureScreenshot) {
    normalized.failureScreenshot = toRunRelative(normalized.failureScreenshot, runDir);
  }

  await ensureDir(dir);
  await writeJson(path.join(dir, `${material.engine}.json`), normalized);
  await writeText(path.join(dir, `${material.engine}.md`), materialToMarkdown(normalized, subQuestion));
  return normalized;
}

function cleanSources(sources: Material["citations"]): Material["citations"] {
  return dedupeSources(sources.map(({ url, title, snippet, ...source }) => ({
    ...source,
    favicon: undefined,
    url: url && redactWebSecrets(url) === url ? url : undefined,
    title: title ? redactWebSecrets(title) : undefined,
    snippet: snippet ? redactWebSecrets(snippet) : undefined,
  })));
}

function toRunRelative(file: string, runDir: string): string {
  if (!path.isAbsolute(file)) return file;
  const rel = path.relative(runDir, file);
  return rel.startsWith("..") ? file : rel.replace(/\\/g, "/");
}

export function materialToMarkdown(material: Material, subQuestion: SubQuestion): string {
  const status =
    material.status === "ok"
      ? "成功"
      : material.status === "timeout"
        ? "超时"
        : material.status === "needs_user_action"
          ? "需要人工处理"
          : "失败";
  const citations = material.citations.length
    ? material.citations
        .map((source, index) => {
          const title = source.title || source.site || "(无标题)";
          const url = source.url ? ` — ${source.url}` : "";
          const quality = source.quality ? ` \`${source.quality}\`` : "";
          return `${index + 1}. ${title}${url}${quality}`;
        })
        .join("\n")
    : "（无结构化引用）";
  const searchSources = material.searchSources.length
    ? material.searchSources
        .map((source, index) => {
          const site = source.site || "";
          const title = source.title || "";
          const snippet = source.snippet || "";
          return `${index + 1}. **${site}** | ${title}\n   > ${snippet}`;
        })
        .join("\n")
    : "（无来源卡片）";
  const notes = material.notes?.length ? material.notes.map((n) => `- ${n}`).join("\n") : "- 无";

  return `# ${material.subQuestionId.toUpperCase()} · ${engineLabel(material.engine)} 原始材料

- 状态：**${status}**
- 引擎：${engineLabel(material.engine)}
- 子问题：${subQuestion.question}
- 会话链接：${material.conversationUrl || "—"}
- 开始：${material.startedAt}
- 结束：${material.finishedAt}
- 耗时：${Math.round((material.durationMs || 0) / 1000)}s
${material.error ? `- 错误：${material.error}` : ""}
${material.rawHtmlPath ? `- 原始 HTML：\`${material.rawHtmlPath}\`` : ""}
${material.failureScreenshot ? `- 失败截图：\`${material.failureScreenshot}\`` : ""}

## 调研回答

${material.answerText || "（空）"}

## 结构化引用

${citations}

## 搜索引擎来源卡片

${searchSources}

## 执行备注

${notes}

## 发送给引擎的完整提示词

\`\`\`text
${material.prompt}
\`\`\`
`;
}

export function engineLabel(engine: string): string {
  return engine === "deepseek" ? "DeepSeek" : engine === "workbuddy" ? "WorkBuddy" : engine;
}
