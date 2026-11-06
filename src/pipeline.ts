import path from "node:path";
import { checkEgoBrowser, resolveModel, type ResolvedModel } from "./config.ts";
import { createTaskSpace, finishTaskSpace, preflightBrowsers, runEngineJob } from "./browser/ego.ts";
import { checkCitation } from "./citations.ts";
import { validatePlan } from "./research-plan.ts";
import { PiAgent } from "./agents/session.ts";
import {
  analysisSystemPrompt,
  analysisUserPrompt,
  decompositionSystemPrompt,
  decompositionUserPrompt,
  enginePrompt,
  finalSystemPrompt,
  finalUserPrompt,
} from "./agents/prompts.ts";
import { persistMaterial } from "./materials.ts";
import { buildReportFile, buildReportHtml, subQuestionFolder, type ReportInput } from "./report/report.ts";
import type { RunContext } from "./run-context.ts";
import type {
  Analysis,
  CitationCheck,
  Conclusion,
  Decomposition,
  EngineName,
  Material,
  PipelineResult,
  PreflightResult,
  SourceRef,
  SubQuestion,
} from "./types.ts";
import {
  classifyDomain,
  isPublicResearchUrl,
  cleanUrl,
  domainOf,
  ensureDir,
  normalizeConfidence,
  normalizeStrength,
  normalizeVerdict,
  nowIso,
  pMap,
  truncate,
  verdictLabel,
} from "./util.ts";

export async function runPipeline(ctx: RunContext): Promise<PipelineResult> {
  const options = ctx.meta.options;
  let spaceId: number | undefined;
  let activeEngines: EngineName[] = [...options.engines];
  let resolved: ResolvedModel | undefined;
  let decomposition: Decomposition | undefined;
  let materials: Material[] = [];
  let citations: CitationCheck[] = [];
  let analyses: Analysis[] = [];
  let conclusion: Conclusion | undefined;

  const phase = async (name: string, message: string): Promise<void> => {
    ctx.throwIfCancelled();
    await ctx.update({ phase: name });
    ctx.emit({ type: "phase", phase: name, status: "start", message });
  };

  const modelConfig = (timeoutMs = 6 * 60 * 1000) => {
    if (!resolved) throw new Error("模型尚未初始化");
    return {
      modelRuntime: resolved.runtime,
      model: resolved.model,
      modelLabel: resolved.label,
      thinkingLevel: options.thinkingLevel,
      cwd: ctx.dir,
      signal: ctx.signal,
      timeoutMs,
    };
  };

  try {
    await ctx.setStatus("running", "init");
    ctx.emit({ type: "run", status: "start", phase: "init", message: "开始调研", data: { question: options.question } });

    await phase("preflight", "检查模型与浏览器环境");
    resolved = await resolveModel(options.model);
    await ctx.update({ model: resolved.label, modelLabel: resolved.label });
    ctx.emit({
      type: "agent",
      phase: "preflight",
      status: "info",
      message: `综合模型：${resolved.label}`,
      data: { model: resolved.label },
    });

    ctx.throwIfCancelled();
    const ego = await checkEgoBrowser();
    if (!ego.ok) {
      throw new Error(
        `未检测到可用的 ego-browser：${ego.error ?? "unknown"}\n` +
          "请从 https://lite.ego.app/ 安装 Ego Lite 并完成首次引导，确认 `ego-browser --version` 可执行。无需安装 Skill。",
      );
    }
    ctx.emit({
      type: "agent",
      phase: "preflight",
      status: "info",
      message: `ego-browser 可用${ego.version ? `：${ego.version}` : ""}`,
    });

    ctx.throwIfCancelled();
    const spaceName = `digsight-${ctx.id}`;
    spaceId = await createTaskSpace(spaceName);
    await ctx.update({ spaceId, spaceName });
    ctx.emit({
      type: "agent",
      phase: "preflight",
      status: "info",
      message: `已创建浏览器任务空间 ${spaceName}（spaceId=${spaceId}）`,
      data: { spaceId, spaceName },
    });

    ctx.throwIfCancelled();
    const preflight = await preflightBrowsers({
      spaceId,
      signal: ctx.signal,
      engines: options.engines,
      shotsDir: ctx.path("preflight"),
      resultPath: ctx.path("preflight.json"),
      onProgress: (engine, message) => {
        ctx.emit({
          type: "engine",
          phase: "preflight",
          engine,
          status: "progress",
          message: `${engineLabel(engine)}：${message}`,
        });
      },
    });
    await ctx.writeJson("preflight.json", preflight);
    if (preflight.keepPages) ctx.keepPages = true;

    activeEngines = options.engines.filter((engine) => preflight.engines[engine]?.ok);
    for (const engine of options.engines) {
      const result = preflight.engines[engine];
      if (result?.ok) {
        ctx.emit({
          type: "engine",
          phase: "preflight",
          engine,
          status: "ok",
          message: `${engineLabel(engine)} 浏览器可用`,
        });
      } else {
        ctx.emit({
          type: "engine",
          phase: "preflight",
          engine,
          status: "failed",
          message: `${engineLabel(engine)} 不可用：${result?.error ?? "未知原因"}`,
          data: result,
        });
        if (result?.needsUserAction) ctx.keepPages = true;
      }
    }
    await ctx.update({
      activeEngines,
      counts: { ...ctx.meta.counts, engines: activeEngines.length },
    });

    if (!activeEngines.length) {
      const detail = options.engines
        .map((engine) => `${engineLabel(engine)}：${preflight.engines[engine]?.error ?? "不可用"}`)
        .join("；");
      throw new Error(
        `没有可用的调研引擎。${detail}。请先在 ego 浏览器中完成登录/验证后重试。` +
          (preflight.keepPages ? "相关页面已保留在浏览器中，处理完成后可直接重跑。" : ""),
      );
    }
    if (activeEngines.length < options.engines.length) {
      ctx.emit({
        type: "log",
        phase: "preflight",
        status: "info",
        message: `将仅使用可用引擎继续：${activeEngines.map(engineLabel).join("、")}`,
      });
    }
    ctx.emit({ type: "phase", phase: "preflight", status: "ok", message: "环境检查通过" });

    /* ------------------------------------------------------------------ */
    /* 1. Decompose                                                       */
    /* ------------------------------------------------------------------ */
    await phase("decompose", "拆解核心问题");
    const decomposeAgent = await PiAgent.create(decompositionSystemPrompt(), modelConfig(6 * 60 * 1000));
    let rawDecomposition: Decomposition;
    try {
      rawDecomposition = await decomposeAgent.structured<Decomposition>(
        decompositionUserPrompt(options.question, options.subQuestionCount),
        {
          retries: 2,
          validate: plan => validatePlan(plan, options.subQuestionCount, options.question),
          onRetry: (error, attempt) => {
            ctx.emit({
              type: "agent",
              phase: "decompose",
              status: "progress",
              message: `调研计划需修正，正在重试（${attempt}）：${error.message}`,
            });
          },
        },
      );
    } finally {
      decomposeAgent.dispose();
    }
    decomposition = normalizeDecomposition(rawDecomposition, options.question);
    await ctx.writeJson("decomposition.json", decomposition);
    await ctx.writeText("decomposition.md", decompositionToMarkdown(decomposition));
    await ctx.update({ title: decomposition.title, counts: { ...ctx.meta.counts, subQuestions: decomposition.subQuestions.length } });
    for (const question of decomposition.subQuestions) {
      ctx.emit({
        type: "subquestion",
        phase: "research",
        subQuestionId: question.id,
        status: "info",
        message: question.question,
        data: question,
      });
    }
    ctx.emit({
      type: "phase",
      phase: "decompose",
      status: "ok",
      message: `拆解完成：${decomposition.subQuestions.length} 个核心问题`,
      data: decomposition,
    });

    /* ------------------------------------------------------------------ */
    /* 2. Research in parallel                                            */
    /* ------------------------------------------------------------------ */
    await phase("research", "并行调研核心问题");
    const subQuestions = decomposition.subQuestions;
    await ensureDir(ctx.path("materials"));

    const allMaterials = await pMap(subQuestions, options.concurrency, async (question, index) => {
      ctx.throwIfCancelled();
      const folder = subQuestionFolder(question.id, index);
      const qDir = ctx.path("materials", folder);
      await ensureDir(qDir);
      ctx.emit({
        type: "subquestion",
        phase: "research",
        subQuestionId: question.id,
        status: "start",
        message: `开始调研：${question.question}`,
        data: { index: index + 1, question },
      });

      const engineResults = await pMap(activeEngines, activeEngines.length, async (engine) => {
          ctx.throwIfCancelled();
          const materialId = `${question.id}-${engine}`;
          ctx.emit({
            type: "engine",
            phase: "research",
            subQuestionId: question.id,
            engine,
            status: "start",
            message: `${engineLabel(engine)} 开始调研 ${question.id}`,
          });
          const started = Date.now();
          try {
            const prompt = enginePrompt({
              engine,
              originalQuestion: options.question,
              decomposition: decomposition!,
              subQuestion: question,
              index: index + 1,
              total: subQuestions.length,
            });
            const material = await runEngineJob(engine, {
              spaceId: spaceId!,
              signal: ctx.signal,
              subQuestionId: question.id,
              question: question.question,
              prompt,
              timeoutMs: options.researchTimeoutMs,
              resultPath: path.join(qDir, `${engine}.json`),
              rawHtmlPath: options.saveRawHtml ? path.join(qDir, `${engine}.raw.html`) : "",
              failureShotPath: path.join(qDir, `${engine}.failure.png`),
              onProgress: (message, data) => {
                ctx.emit({
                  type: "engine",
                  phase: "research",
                  subQuestionId: question.id,
                  engine,
                  status: "progress",
                  message: `${engineLabel(engine)}：${message}`,
                  data,
                });
              },
            });
            const persisted = await persistMaterial({ material, dir: qDir, runDir: ctx.dir, subQuestion: question });
            const ok = persisted.status === "ok";
            if (ok) {
              ctx.emit({
                type: "engine",
                phase: "research",
                subQuestionId: question.id,
                engine,
                status: "ok",
                message: `${engineLabel(engine)} 完成：${persisted.answerText.length} 字，${persisted.citations.length} 个引用`,
                data: {
                  durationMs: Date.now() - started,
                  answerChars: persisted.answerText.length,
                  citations: persisted.citations.length,
                  searchCount: persisted.searchCount,
                  conversationUrl: persisted.conversationUrl,
                  status: persisted.status,
                },
              });
            } else {
              ctx.emit({
                type: "engine",
                phase: "research",
                subQuestionId: question.id,
                engine,
                status: persisted.status === "timeout" ? "timeout" : "failed",
                message: `${engineLabel(engine)} ${persisted.status === "timeout" ? "超时" : "失败"}：${persisted.error ?? "未知原因"}`,
                data: { status: persisted.status, error: persisted.error, needsUserAction: persisted.needsUserAction },
              });
              if (persisted.needsUserAction) ctx.keepPages = true;
            }
            return persisted;
          } catch (error) {
            ctx.throwIfCancelled();
            const message = (error as Error).message || String(error);
            ctx.emit({
              type: "engine",
              phase: "research",
              subQuestionId: question.id,
              engine,
              status: message.includes("超时") ? "timeout" : "failed",
              message: `${engineLabel(engine)} 调研异常：${message}`,
            });
            return await persistMaterial({
              material: makeSyntheticFailure(question, engine, message, options.researchTimeoutMs),
              dir: qDir, runDir: ctx.dir, subQuestion: question,
            });
          }
        });

      // Record engines excluded by preflight so the report keeps a complete
      // accounting of what was and was not collected.
      for (const engine of options.engines) {
        if (activeEngines.includes(engine)) continue;
        const reason = `预检未通过：${engineLabel(engine)} 不可用`;
        const material = makeSyntheticFailure(question, engine, reason, 0);
        const persisted = await persistMaterial({ material, dir: qDir, runDir: ctx.dir, subQuestion: question });
        engineResults.push(persisted);
      }

      ctx.emit({
        type: "subquestion",
        phase: "research",
        subQuestionId: question.id,
        status: "ok",
        message: `完成调研：${question.question}`,
        data: { materials: engineResults.map((m) => ({ engine: m.engine, status: m.status })) },
      });
      return engineResults;
    });

    materials = allMaterials.flat();
    const okCount = materials.filter((m) => m.status === "ok").length;
    const failedCount = materials.length - okCount;
    await ctx.writeJson("materials/index.json", materials);
    await ctx.update({
      counts: { ...ctx.meta.counts, materialsOk: okCount, materialsFailed: failedCount },
    });
    if (okCount === 0) throw new Error("所有调研引擎均未采集到有效材料。请检查登录、额度或执行日志后重新调研；不会用空材料生成结论。");
    ctx.emit({
      type: "phase",
      phase: "research",
      status: "ok",
      message: `调研采集完成：${okCount} 份成功 / ${failedCount} 份失败`,
      data: { ok: okCount, failed: failedCount },
    });

    /* ------------------------------------------------------------------ */
    /* 3. Citation checks                                                 */
    /* ------------------------------------------------------------------ */
    if (options.verifyCitations && options.maxCitations > 0) {
      const candidates = selectCitationCandidates(materials, options.maxCitations);
      if (candidates.length) {
        await phase("verify", "核查引用来源");
        try {
          const deadline = AbortSignal.timeout(8 * 60 * 1000);
          for (const [index, { url, source }] of candidates.entries()) {
            ctx.throwIfCancelled();
            if (deadline.aborted) break;
            ctx.emit({
              type: "citation",
              phase: "verify",
              status: "progress",
              message: `核查引用 ${index + 1}/${candidates.length}：${domainOf(url)}`,
              data: { url, index, total: candidates.length },
            });
            const signal = AbortSignal.any([ctx.signal, deadline, AbortSignal.timeout(25_000)]);
            const check = await checkCitation(url, signal);
            ctx.throwIfCancelled();
            citations.push({ ...check, quality: source.quality });
          }
          await ctx.writeJson("citations/index.json", citations);
          for (const question of subQuestions) {
            const qMaterials = materials.filter((m) => m.subQuestionId === question.id);
            const urls = new Set(qMaterials.flatMap((m) => m.citations.map((c) => c.url).filter(Boolean)));
            const relevant = citations.filter((check) => urls.has(check.url));
            await ctx.writeJson(`citations/${question.id}.json`, relevant);
          }
          const ok = citations.filter((c) => c.ok).length;
          await ctx.update({
            counts: { ...ctx.meta.counts, citationsChecked: citations.length, citationsOk: ok },
          });
          ctx.emit({
            type: "phase",
            phase: "verify",
            status: "ok",
            message: `引用核查完成：${ok}/${citations.length} 个 URL 可访问`,
            data: { checked: citations.length, ok },
          });
        } catch (error) {
          ctx.throwIfCancelled();
          ctx.emit({
            type: "phase",
            phase: "verify",
            status: "failed",
            message: `引用核查失败，将继续基于原始材料分析：${(error as Error).message}`,
          });
        }
      } else {
        ctx.emit({
          type: "phase",
          phase: "verify",
          status: "skip",
          message: "没有可核查的引用 URL，跳过",
        });
      }
    } else {
      ctx.emit({ type: "phase", phase: "verify", status: "skip", message: "已关闭引用核查" });
    }

    /* ------------------------------------------------------------------ */
    /* 4. Per-question analysis                                           */
    /* ------------------------------------------------------------------ */
    await phase("analyze", "交叉核查与逐题推理");
    const analysisConcurrency = Math.min(4, Math.max(1, options.concurrency + 1));
    analyses = await pMap(subQuestions, analysisConcurrency, async (question, index) => {
      ctx.throwIfCancelled();
      const qMaterials = materials.filter((m) => m.subQuestionId === question.id);
      const qChecks = citations.filter((check) =>
        qMaterials.some((m) => m.citations.some((c) => c.url === check.url)),
      );
      ctx.emit({
        type: "agent",
        phase: "analyze",
        subQuestionId: question.id,
        status: "start",
        message: `主调研 Agent 分析 ${question.id}`,
        data: { question: question.question, materials: qMaterials.length, citations: qChecks.length },
      });
      let analysis: Analysis;
      try {
        const agent = await PiAgent.create(analysisSystemPrompt(), modelConfig(6 * 60 * 1000));
        try {
          const raw = await agent.structured<Analysis>(
            analysisUserPrompt({
              originalQuestion: options.question,
              decomposition: decomposition!,
              subQuestion: question,
              materials: qMaterials,
              citationChecks: qChecks,
            }),
            {
              retries: 2,
              validate: value => {
                if (typeof value?.conclusion !== "string" || !value.conclusion.trim()) throw new Error("本题缺少直接答案。");
                if (value.verdict !== "inconclusive" && !value.keyEvidence?.some(e => e?.evidence && e.sources?.length)) throw new Error("请给出支持本题结论的事实及其来源，无法证实时说明还缺什么。");
              },
              onRetry: (error, attempt) => {
                ctx.emit({
                  type: "agent",
                  phase: "analyze",
                  subQuestionId: question.id,
                  status: "progress",
                  message: `${question.id} 分析未完成，正在重试（${attempt}）：${error.message}`,
                });
              },
            },
          );
          analysis = normalizeAnalysis(raw, question);
        } finally {
          agent.dispose();
        }
      } catch (error) {
        ctx.throwIfCancelled();
        const message = (error as Error).message;
        analysis = fallbackAnalysis(question, qMaterials, message);
      }
      await ctx.writeJson(`analysis/${question.id}.json`, analysis);
      await ctx.writeText(`analysis/${question.id}.md`, analysisToMarkdown(analysis, question));
      ctx.emit({
        type: "agent",
        phase: "analyze",
        subQuestionId: question.id,
        status: analysis.analysisUnavailable ? "failed" : "ok",
        message: analysis.analysisUnavailable ? `${question.id} 分析未完成：${analysis.gaps[0]?.replace(/^自动分析失败：/, "")}` : `${question.id}：${analysis.conclusion}`,
        data: analysis,
      });
      return analysis;
    });
    await ctx.writeJson("analysis/index.json", analyses);
    ctx.emit({
      type: "phase",
      phase: "analyze",
      status: "ok",
      message: `已分析 ${analyses.filter(a => !a.analysisUnavailable).length}/${analyses.length} 题`,
    });

    /* ------------------------------------------------------------------ */
    /* 5. Final synthesis                                                 */
    /* ------------------------------------------------------------------ */
    await phase("synthesize", "合成最终结论");
    let synthesisFailed = false;
    try {
      if (analyses.every(a => a.analysisUnavailable)) throw new Error("没有已完成的分题分析");
      const agent = await PiAgent.create(finalSystemPrompt(), modelConfig(8 * 60 * 1000));
      try {
        const raw = await agent.structured<Conclusion>(
          finalUserPrompt({
            originalQuestion: options.question,
            decomposition,
            analyses,
            counts: ctx.meta.counts,
          }),
          {
            retries: 2,
            validate: result => {
              const ids = result?.logicChain?.map(row => row.subQuestionId) ?? [];
              if (!result?.finalConclusion?.trim() || !result.decisionReason?.trim() ||
                  !["supported", "partially_supported", "refuted", "inconclusive"].includes(result.verdict) ||
                  ids.length !== analyses.length || !analyses.every(a => ids.includes(a.subQuestionId))) {
                throw new Error("需要直接回答原问题、解释总判断，并逐一覆盖全部子问题。");
              }
            },
            onRetry: (error, attempt) => {
              ctx.emit({
                type: "agent",
                phase: "synthesize",
                status: "progress",
                message: `综合判断未完成，正在重试（${attempt}）：${error.message}`,
              });
            },
          },
        );
        conclusion = normalizeConclusion(raw, decomposition.title!, analyses);
      } finally {
        agent.dispose();
      }
    } catch (error) {
      ctx.throwIfCancelled();
      synthesisFailed = true;
      conclusion = fallbackConclusion(decomposition.title!, analyses, (error as Error).message);
      ctx.emit({
        type: "agent",
        phase: "synthesize",
        status: "failed",
        message: `最终综合失败，已生成保守汇总：${(error as Error).message}`,
      });
    }
    await ctx.writeJson("conclusion.json", conclusion);
    if (!synthesisFailed) ctx.emit({
      type: "agent", phase: "synthesize", status: "ok",
      message: conclusion.finalConclusion, data: conclusion,
    });
    ctx.emit({ type: "phase", phase: "synthesize", status: synthesisFailed ? "failed" : "ok", message: synthesisFailed ? "未形成总判断，已保留逐题结果" : "最终结论已生成" });

    /* ------------------------------------------------------------------ */
    /* 6. Report                                                          */
    /* ------------------------------------------------------------------ */
    await phase("report", "生成调研报告");
    const finishedAt = nowIso();
    const finalMeta = {
      ...ctx.meta,
      title: conclusion.title,
      status: "completed" as const,
      phase: "done",
      finishedAt,
      durationMs: ctx.meta.startedAt ? Date.now() - new Date(ctx.meta.startedAt).getTime() : 0,
      modelLabel: resolved.label,
      verdict: conclusion.verdict,
      confidence: conclusion.confidence,
      activeEngines,
    };
    const reportInput: ReportInput = {
      meta: finalMeta,
      decomposition,
      analyses,
      conclusion,
      materials,
      citations,
    };
    const reportMd = buildReportFile(reportInput);
    const reportHtml = buildReportHtml(reportInput);
    const reportMdPath = await ctx.writeText("report.md", reportMd);
    const reportHtmlPath = await ctx.writeText("report.html", reportHtml);
    await ctx.update(finalMeta);
    ctx.emit({
      type: "report",
      phase: "report",
      status: "ok",
      message: "调研报告已生成",
      data: { reportMd: "report.md", reportHtml: "report.html" },
    });
    ctx.emit({
      type: "run",
      phase: "done",
      status: "ok",
      message: "调研完成",
      data: {
        conclusion,
        reportMd: "report.md",
        reportHtml: "report.html",
        durationMs: ctx.meta.durationMs,
      },
    });
    await ctx.flushEvents();

    return {
      meta: ctx.meta,
      decomposition,
      materials,
      analyses,
      conclusion,
      reportMdPath,
      reportHtmlPath,
    };
  } catch (error) {
    const message = (error as Error).message || String(error);
    const cancelled = ctx.cancelled || /cancel|abort/i.test(message);
    ctx.emit({
      type: "error",
      phase: ctx.meta.phase,
      status: cancelled ? "cancelled" : "failed",
      message: cancelled ? "运行已取消" : message,
    });
    await ctx.setStatus(cancelled ? "cancelled" : "failed", ctx.meta.phase, cancelled ? "运行已取消" : message);
    ctx.emit({
      type: "run",
      phase: ctx.meta.phase,
      status: cancelled ? "cancelled" : "failed",
      message: cancelled ? "运行已取消" : "运行失败",
      data: { error: cancelled ? "运行已取消" : message },
    });
    throw error;
  } finally {
    await ctx.flushEvents().catch(() => {});
    if (spaceId && !ctx.keepPages && !options.keepSpace) {
      try {
        await finishTaskSpace(spaceId);
        ctx.emit({ type: "log", phase: "cleanup", status: "info", message: "浏览器任务空间已关闭" });
      } catch (error) {
        ctx.emit({
          type: "log",
          phase: "cleanup",
          status: "info",
          message: `关闭浏览器任务空间失败（可手动关闭）：${(error as Error).message}`,
        });
      }
    } else if (spaceId) {
      ctx.meta.spaceKept = true;
      await ctx.update({ spaceKept: true }).catch(() => {});
      ctx.emit({
        type: "log",
        phase: "cleanup",
        status: "info",
        message: `浏览器任务空间已保留：spaceId=${spaceId}。处理登录/验证后可重跑。`,
      });
    }
    await ctx.flushEvents().catch(() => {});
  }
}

/* -------------------------------------------------------------------------- */
/* Normalizers                                                                */
/* -------------------------------------------------------------------------- */

function normalizeDecomposition(raw: Decomposition, question: string): Decomposition {
  const list = Array.isArray(raw?.subQuestions) ? raw.subQuestions : [];
  const subQuestions: SubQuestion[] = list
    .map((item, index) => ({
      id: `q${index + 1}`,
      question: String(item?.question ?? "").trim(),
      logicRole: String(item?.logicRole ?? "未分类").trim() || "未分类",
      whyItMatters: String(item?.whyItMatters ?? "").trim(),
      evidenceNeeded: Array.isArray(item?.evidenceNeeded)
        ? item.evidenceNeeded.map((x) => String(x)).filter(Boolean)
        : [],
      researchBrief: String(item?.researchBrief ?? "").trim(),
      successCriteria: String(item?.successCriteria ?? "").trim() || "能给出可核查的证据和明确回答",
    }))
    .filter((item) => item.question);
  for (const item of subQuestions) {
    if (!item.whyItMatters) item.whyItMatters = "该问题用于补齐论证链中的一个关键环节。";
    if (!item.researchBrief) {
      item.researchBrief = `围绕“${item.question}”检索公开信息。需要重点核实：${
        item.evidenceNeeded.length ? item.evidenceNeeded.join("；") : "相关事实、数据、来源与时间口径"
      }。优先一手来源，给出反面证据。`;
    }
  }
  return {
    title: raw.title!.trim(),
    questionRestated: String(raw?.questionRestated ?? question).trim() || question,
    thesisToTest: String(raw?.thesisToTest ?? `“${question}”是否成立，以及在什么条件下成立。`).trim(),
    reasoningApproach:
      String(raw?.reasoningApproach ?? "").trim() ||
      "将原命题拆为现状、机制、规模与反证四类可独立核查的问题，再按证据链合成最终判断。",
    subQuestions,
  };
}

function normalizeAnalysis(raw: Analysis, question: SubQuestion): Analysis {
  const keyEvidence = Array.isArray(raw?.keyEvidence)
    ? raw.keyEvidence
        .map((item) => ({
          claim: String(item?.claim ?? "").trim(),
          evidence: String(item?.evidence ?? "").trim(),
          sources: Array.isArray(item?.sources) ? item.sources.map((s) => String(s)).filter(Boolean) : [],
          strength: normalizeStrength(item?.strength),
          corroboration: normalizeCorroboration(item?.corroboration),
        }))
        .filter((item) => item.claim || item.evidence)
        .slice(0, 10)
    : [];
  const conflicts = Array.isArray(raw?.conflicts)
    ? raw.conflicts
        .map((item) => ({
          issue: String(item?.issue ?? "").trim(),
          positions: Array.isArray(item?.positions) ? item.positions.map((x) => String(x)) : [],
          resolution: String(item?.resolution ?? "").trim(),
        }))
        .filter((item) => item.issue)
    : [];
  const conclusion = String(raw?.conclusion ?? "").trim() || "材料不足以形成明确结论。";
  return {
    subQuestionId: question.id,
    question: question.question,
    readingQuestion: typeof raw.readingQuestion === "string" ? raw.readingQuestion.trim() || undefined : undefined,
    conclusion,
    verdict: normalizeVerdict(raw?.verdict),
    confidence: normalizeConfidence(raw?.confidence),
    engineAgreement: normalizeAgreement(raw?.engineAgreement),
    keyEvidence,
    conflicts,
    gaps: Array.isArray(raw?.gaps) ? raw.gaps.map((g) => String(g)).filter(Boolean) : [],
    reasoning: String(raw?.reasoning ?? "").trim() || "模型未返回推理过程。",
  };
}

function fallbackAnalysis(question: SubQuestion, materials: Material[], error: string): Analysis {
  const okMaterials = materials.filter((m) => m.status === "ok");
  return {
    subQuestionId: question.id,
    question: question.question,
    analysisUnavailable: true,
    conclusion:
      okMaterials.length > 0
        ? "自动分析未能完成，无法可靠判断该子问题；请人工复核原始材料。"
        : "本题未取得可用材料，暂时不能作出判断。",
    verdict: "inconclusive",
    confidence: 0,
    engineAgreement: "unknown",
    keyEvidence: [],
    conflicts: [],
    gaps: [`自动分析失败：${error}`, ...(okMaterials.length ? [] : ["缺少可用原始材料"])],
    reasoning: "分析模型调用或 JSON 解析失败，系统未将未经核实的材料强行上升为结论。",
  };
}

function normalizeConclusion(raw: Conclusion, title: string, analyses: Analysis[]): Conclusion {
  const rawSummary = Array.isArray(raw?.executiveSummary) ? raw.executiveSummary.map(String).filter(Boolean) : [];
  const rawChain = Array.isArray(raw?.logicChain) ? raw.logicChain : [];
  const rawFindings = Array.isArray(raw?.keyFindings) ? raw.keyFindings : [];
  const rawCounter = Array.isArray(raw?.counterEvidence) ? raw.counterEvidence : [];
  const rawUncertainties = Array.isArray(raw?.uncertainties) ? raw.uncertainties.map(String).filter(Boolean) : [];
  const rawRecommendations = Array.isArray(raw?.recommendations)
    ? raw.recommendations.map(String).filter(Boolean)
    : [];

  const logicChain =
    rawChain.length > 0
      ? rawChain.map((item, index) => ({
          subQuestionId: String(item?.subQuestionId ?? analyses[index]?.subQuestionId ?? `q${index + 1}`),
          premise: String(item?.premise ?? ""),
          status: String(item?.status ?? ""),
          basis: String(item?.basis ?? ""),
        }))
      : analyses.map((analysis) => ({
          subQuestionId: analysis.subQuestionId,
          premise: analysis.question,
          status: verdictStatus(analysis.verdict),
          basis: analysis.conclusion,
        }));

  const keyFindings =
    rawFindings.length > 0
      ? rawFindings.map((item) => ({
          finding: String(item?.finding ?? "").trim(),
          evidence: String(item?.evidence ?? "").trim(),
          sources: Array.isArray(item?.sources) ? item.sources.map(String).filter(Boolean) : [],
          strength: normalizeStrength(item?.strength),
        }))
      : analyses
          .flatMap((analysis) =>
            analysis.keyEvidence.map((evidence) => ({
              finding: evidence.claim,
              evidence: evidence.evidence,
              sources: evidence.sources,
              strength: evidence.strength,
            })),
          )
          .slice(0, 8);

  const counterEvidence =
    rawCounter.length > 0
      ? rawCounter.map((item) => ({
          point: String(item?.point ?? "").trim(),
          implication: String(item?.implication ?? "").trim(),
        }))
      : analyses.flatMap((analysis) =>
          analysis.conflicts.map((conflict) => ({
            point: conflict.issue,
            implication: conflict.resolution,
          })),
        );

  const uncertainties = rawUncertainties.length
    ? rawUncertainties
    : [...new Set(analyses.flatMap((analysis) => analysis.gaps))].slice(0, 12);

  const finalConclusion =
    String(raw?.finalConclusion ?? "").trim() ||
    (analyses.length
      ? analyses.map((analysis) => analysis.conclusion).join("；")
      : "现有材料不足以形成结论。");
  const verdict = normalizeVerdict(raw.verdict);
  const confidence = normalizeConfidence(raw.confidence);

  return {
    title,
    finalConclusion,
    decisionReason: typeof raw?.decisionReason === "string" ? raw.decisionReason.trim() : undefined,
    verdict,
    confidence,
    executiveSummary: rawSummary.length
      ? rawSummary.slice(0, 6)
      : analyses.map((a) => `${a.question} → ${a.conclusion}`).slice(0, 5),
    logicChain,
    keyFindings,
    counterEvidence,
    uncertainties,
    recommendations: rawRecommendations.slice(0, 8),
    methodologyNote:
      String(raw?.methodologyNote ?? "").trim() ||
      "本报告由两个独立联网调研引擎采集材料，主调研 Agent 逐题交叉核查后，按论证链合成最终判断。引用核查通过浏览器实际打开 URL 完成；未能访问的来源已标注。",
  };
}

function fallbackConclusion(title: string, analyses: Analysis[], error: string): Conclusion {
  return {
    title,
    finalConclusion:
      "本次未能形成总判断。各题已完成的分析保留在下文。",
    verdict: "inconclusive",
    confidence: 0,
    executiveSummary: analyses.map((a) => `${a.question} → ${a.conclusion}`).slice(0, 5),
    logicChain: analyses.map((analysis) => ({
      subQuestionId: analysis.subQuestionId,
      premise: analysis.question,
      status: verdictStatus(analysis.verdict),
      basis: analysis.conclusion,
    })),
    keyFindings: analyses
      .flatMap((analysis) =>
        analysis.keyEvidence.map((evidence) => ({
          finding: evidence.claim,
          evidence: evidence.evidence,
          sources: evidence.sources,
          strength: evidence.strength,
        })),
      )
      .slice(0, 8),
    counterEvidence: analyses.flatMap((analysis) =>
      analysis.conflicts.map((conflict) => ({ point: conflict.issue, implication: conflict.resolution })),
    ),
    uncertainties: [`最终综合失败：${error}`, ...new Set(analyses.flatMap((a) => a.gaps))].slice(0, 12),
    recommendations: [],
    methodologyNote: "最终综合阶段失败，报告由子问题分析机械汇总生成；证据链仍然可审计。",
  };
}

function normalizeAgreement(value: unknown): Analysis["engineAgreement"] {
  const s = String(value ?? "").toLowerCase();
  if (s.includes("high") || s.includes("高")) return "high";
  if (s.includes("low") || s.includes("低")) return "low";
  if (s.includes("medium") || s.includes("中")) return "medium";
  return "unknown";
}

function normalizeCorroboration(value: unknown): "deepseek" | "workbuddy" | "both" | "none" {
  const s = String(value ?? "").toLowerCase();
  if (s === "both" || s.includes("双") || s.includes("两")) return "both";
  if (s.includes("deepseek")) return "deepseek";
  if (s.includes("workbuddy")) return "workbuddy";
  return "none";
}

function verdictStatus(verdict: Analysis["verdict"]): string {
  switch (verdict) {
    case "supported":
      return "已证实";
    case "partially_supported":
      return "部分证实";
    case "refuted":
      return "被反驳";
    default:
      return "证据不足";
  }
}

/* -------------------------------------------------------------------------- */
/* Citation selection & normalization                                         */
/* -------------------------------------------------------------------------- */

function selectCitationCandidates(materials: Material[], max: number): Array<{ url: string; source: SourceRef }> {
  const seen = new Set<string>();
  const candidates: Array<{ url: string; source: SourceRef; quality: number }> = [];
  for (const material of materials) {
    for (const source of material.citations) {
      if (!source.url || !isPublicResearchUrl(source.url)) continue;
      const url = cleanUrl(source.url);
      if (!url || seen.has(url)) continue;
      const domain = domainOf(url);
      if (!domain) continue;
      if (/(^|\.)workbuddy\.cn$|(^|\.)deepseek\.com$/i.test(domain)) continue;
      seen.add(url);
      const quality = source.quality ?? classifyDomain(url);
      candidates.push({
        url,
        source: { ...source, url, quality },
        quality: quality === "high" ? 0 : quality === "medium" ? 1 : quality === "low" ? 3 : 2,
      });
    }
  }
  const usedDomains = new Set<string>();
  const pool = [...candidates];
  const selected: Array<{ url: string; source: SourceRef }> = [];
  while (selected.length < max && pool.length > 0) {
    let bestIndex = 0;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let i = 0; i < pool.length; i++) {
      const candidate = pool[i]!;
      const domain = domainOf(candidate.url);
      const score = candidate.quality * 10 + (usedDomains.has(domain) ? 5 : 0);
      if (score < bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    const [chosen] = pool.splice(bestIndex, 1);
    if (!chosen) break;
    selected.push({ url: chosen.url, source: chosen.source });
    usedDomains.add(domainOf(chosen.url));
  }
  return selected;
}

function makeSyntheticFailure(
  question: SubQuestion,
  engine: EngineName,
  error: string,
  timeoutMs: number,
): Material {
  const started = nowIso();
  return {
    id: `${question.id}-${engine}`,
    subQuestionId: question.id,
    engine,
    question: question.question,
    prompt: "",
    status: error.includes("超时") ? "timeout" : "failed",
    error,
    startedAt: started,
    finishedAt: nowIso(),
    durationMs: timeoutMs,
    answerMarkdown: "",
    answerText: "",
    citations: [],
    searchSources: [],
    notes: ["DIGSIGHT 宿主补写的失败记录"],
  };
}

/* -------------------------------------------------------------------------- */
/* Markdown sidecars                                                          */
/* -------------------------------------------------------------------------- */

function decompositionToMarkdown(decomposition: Decomposition): string {
  return `# 调研拆解

- **问题重述**：${decomposition.questionRestated}
- **待检验命题**：${decomposition.thesisToTest}
- **论证思路**：${decomposition.reasoningApproach}

${decomposition.subQuestions
  .map(
    (q) => `## ${q.id.toUpperCase()} · ${q.question}

- **论证角色**：${q.logicRole}
- **为什么重要**：${q.whyItMatters}
- **需要证据**：${q.evidenceNeeded.map((x) => `\n  - ${x}`).join("")}
- **成功判据**：${q.successCriteria}
- **调研任务书**：${q.researchBrief}
`,
  )
  .join("\n")}`;
}

function analysisToMarkdown(analysis: Analysis, question: SubQuestion): string {
  return `# ${analysis.subQuestionId.toUpperCase()} · 子问题分析

- **问题**：${question.question}
- **结论**：${analysis.conclusion}
- **判定**：${verdictLabel(analysis.verdict)}
- **置信度**：${Math.round(analysis.confidence * 100)}%
- **引擎一致性**：${analysis.engineAgreement}

## 关键证据

${analysis.keyEvidence
  .map(
    (e) =>
      `- **[${e.strength}] ${e.claim}**\n  - 证据：${e.evidence}\n  - 来源：${e.sources.join("；") || "—"}\n  - 印证：${e.corroboration}`,
  )
  .join("\n") || "（无）"}

## 冲突

${analysis.conflicts.map((c) => `- **${c.issue}**\n  - 分歧：${c.positions.join("；")}\n  - 处理：${c.resolution}`).join("\n") || "（无）"}

## 缺口

${analysis.gaps.map((g) => `- ${g}`).join("\n") || "（无）"}

## 推理

${analysis.reasoning}
`;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function engineLabel(engine: EngineName): string {
  return engine === "deepseek" ? "DeepSeek" : "WorkBuddy";
}

// Re-export a couple of helpers used by the web layer without importing deeply.
export { preflightBrowsers };
export type { PreflightResult, ResolvedModel };
