import type { Decomposition, QuestionCount } from "./types.ts";

export const AUTO_QUESTION_LIMIT = 8;
export const MANUAL_QUESTION_LIMIT = 12;

export function questionCount(value: unknown): QuestionCount {
  if (value === undefined || value === "auto") return "auto";
  const count = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > MANUAL_QUESTION_LIMIT) {
    throw new Error(`子问题数须为 auto 或 1–${MANUAL_QUESTION_LIMIT} 的整数。`);
  }
  return count;
}

/** Reject incomplete plans before opening research sessions; never silently drop questions. */
export function validatePlan(plan: Decomposition, count: QuestionCount, question: string): void {
  const title = typeof plan?.title === "string" ? plan.title.trim() : "";
  if (!title || [...title].length > 32 || title === question.trim() || /[\r\n]|(?:…|\.{3})$/.test(title)) {
    throw new Error("请概括研究对象和要判断的事，另拟一行不超过 32 个字符的标题，不要照抄提问。");
  }
  const list = plan.subQuestions;
  if (!Array.isArray(list) || (count === "auto" ? list.length < 1 || list.length > AUTO_QUESTION_LIMIT : list.length !== count)) {
    throw new Error(count === "auto" ? `自动拆解需要 1–${AUTO_QUESTION_LIMIT} 个子问题。` : `用户指定了 ${count} 个子问题，请返回恰好 ${count} 个。`);
  }
  const texts = list.map(q => typeof q?.question === "string" ? q.question.trim().replace(/[\s？?。！!]+/g, "") : "");
  if (texts.some(q => !q) || new Set(texts).size !== list.length) throw new Error("子问题不可留空或重复，请分别检验不同证据。");
}
