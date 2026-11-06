/**
 * DIGSIGHT domain types.
 *
 * The whole app is intentionally file-first: every phase writes a JSON/Markdown
 * artifact into the run directory so a report can be audited and regenerated.
 */

export const ENGINES = ["deepseek", "workbuddy"] as const;
export type EngineName = (typeof ENGINES)[number];

export type ThinkingLevel = "off" | "low" | "medium" | "high";

export type Verdict = "supported" | "partially_supported" | "refuted" | "inconclusive";
export type Strength = "strong" | "medium" | "weak";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type QuestionCount = "auto" | number;

export interface RunOptions {
  question: string;
  engines: EngineName[];
  subQuestionCount: QuestionCount;
  /** How many sub-questions are researched at the same time. */
  concurrency: number;
  model?: string;
  thinkingLevel: ThinkingLevel;
  /** Per web-agent session, in milliseconds. */
  researchTimeoutMs: number;
  verifyCitations: boolean;
  maxCitations: number;
  /** Keep the ego TaskSpace open after the run (for debugging/login). */
  keepSpace: boolean;
  saveRawHtml: boolean;
  runsDir: string;
}

export interface RunCounts {
  subQuestions: number;
  engines: number;
  materialsOk: number;
  materialsFailed: number;
  citationsChecked: number;
  citationsOk: number;
}

export interface RunMeta {
  id: string;
  question: string;
  title?: string;
  options: RunOptions;
  status: RunStatus;
  phase: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  error?: string;
  model?: string;
  modelLabel?: string;
  verdict?: Verdict;
  confidence?: number;
  activeEngines?: EngineName[];
  spaceId?: number;
  spaceName?: string;
  spaceKept?: boolean;
  counts: RunCounts;
}

export interface SubQuestion {
  id: string;
  question: string;
  logicRole: string;
  whyItMatters: string;
  evidenceNeeded: string[];
  researchBrief: string;
  successCriteria: string;
}

export interface Decomposition {
  /** Older saved plans may predate planning-stage titles. */
  title?: string;
  questionRestated: string;
  thesisToTest: string;
  reasoningApproach: string;
  subQuestions: SubQuestion[];
}

export interface SourceRef {
  title?: string;
  url?: string;
  site?: string;
  snippet?: string;
  publishedAt?: string;
  favicon?: string;
  quality?: "high" | "medium" | "low" | "unknown";
}

export type MaterialStatus = "ok" | "failed" | "timeout" | "needs_user_action";

export interface Material {
  id: string;
  subQuestionId: string;
  engine: EngineName;
  question: string;
  prompt: string;
  status: MaterialStatus;
  error?: string;
  needsUserAction?: boolean;
  conversationUrl?: string;
  pageTitle?: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  answerMarkdown: string;
  answerText: string;
  citations: SourceRef[];
  searchSources: SourceRef[];
  searchCount?: number;
  rawText?: string;
  rawHtmlPath?: string;
  failureScreenshot?: string;
  notes?: string[];
}

export interface CitationCheck {
  url: string;
  ok: boolean;
  status?: number;
  title?: string;
  finalUrl?: string;
  excerpt?: string;
  description?: string;
  error?: string;
  checkedAt: string;
  quality?: SourceRef["quality"];
}

export interface EvidenceItem {
  claim: string;
  evidence: string;
  sources: string[];
  strength: Strength;
  corroboration: "deepseek" | "workbuddy" | "both" | "none";
}

export interface ConflictItem {
  issue: string;
  positions: string[];
  resolution: string;
}

export interface Analysis {
  readingQuestion?: string;
  analysisUnavailable?: boolean;
  subQuestionId: string;
  question: string;
  conclusion: string;
  verdict: Verdict;
  confidence: number;
  engineAgreement: "high" | "medium" | "low" | "unknown";
  keyEvidence: EvidenceItem[];
  conflicts: ConflictItem[];
  gaps: string[];
  reasoning: string;
}

export interface LogicChainItem {
  subQuestionId: string;
  premise: string;
  status: string;
  basis: string;
}

export interface FinalFinding {
  finding: string;
  evidence: string;
  sources: string[];
  strength: Strength;
}

export interface CounterEvidence {
  point: string;
  implication: string;
}

export interface Conclusion {
  decisionReason?: string;
  title: string;
  finalConclusion: string;
  verdict: Verdict;
  confidence: number;
  executiveSummary: string[];
  logicChain: LogicChainItem[];
  keyFindings: FinalFinding[];
  counterEvidence: CounterEvidence[];
  uncertainties: string[];
  recommendations: string[];
  methodologyNote: string;
}

export interface EnginePreflight {
  engine: EngineName;
  ok: boolean;
  needsUserAction: boolean;
  url?: string;
  title?: string;
  error?: string;
}

export interface PreflightResult {
  engines: Record<string, EnginePreflight>;
  keepPages: boolean;
}

export type EventType =
  | "run"
  | "phase"
  | "subquestion"
  | "engine"
  | "citation"
  | "agent"
  | "report"
  | "log"
  | "error";

export type EventStatus =
  | "start"
  | "progress"
  | "ok"
  | "failed"
  | "timeout"
  | "skip"
  | "info"
  | "cancelled";

export interface ProgressEvent {
  seq: number;
  ts: string;
  runId: string;
  type: EventType;
  status?: EventStatus;
  phase?: string;
  subQuestionId?: string;
  engine?: EngineName;
  message: string;
  data?: unknown;
}

export interface RunSummary {
  meta: RunMeta;
  conclusion?: Conclusion;
  decomposition?: Decomposition;
  analyses?: Analysis[];
  files?: string[];
}

export interface PipelineResult {
  meta: RunMeta;
  decomposition: Decomposition;
  materials: Material[];
  analyses: Analysis[];
  conclusion: Conclusion;
  reportMdPath: string;
  reportHtmlPath: string;
}
