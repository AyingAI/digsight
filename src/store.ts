import { promises as fs } from "node:fs";
import path from "node:path";
import type { Analysis, Conclusion, Decomposition, RunMeta, RunSummary } from "./types.ts";
import { readJsonSafe } from "./util.ts";

const IGNORE_FILES = new Set([".DS_Store"]);
export function validRunId(id: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id);
}

export async function runDirectory(runId: string, runsDir: string): Promise<string | undefined> {
  if (!validRunId(runId)) return undefined;
  try {
    const root = await fs.realpath(runsDir);
    const dir = path.join(root, runId);
    if (await fs.realpath(dir) !== dir) return undefined;
    return dir;
  } catch { return undefined; }
}

export async function readRunJson<T>(dir: string, relative: string): Promise<T | undefined> {
  const file = await resolveRunFile(dir, relative);
  return file ? readJsonSafe<T>(file) : undefined;
}

const HIDDEN_FROM_HISTORY = ".hidden-from-history";

/** Removing a history entry must never remove a report or its sources. */
export async function setHistoryVisibility(runId: string, runsDir: string, visible: boolean): Promise<boolean> {
  const dir = await runDirectory(runId, runsDir);
  if (!dir || (await readRunJson<RunMeta>(dir, "run.json"))?.id !== runId) return false;
  const marker = path.join(dir, HIDDEN_FROM_HISTORY);
  try {
    if (visible) await fs.unlink(marker);
    else await fs.writeFile(marker, "", { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== (visible ? "ENOENT" : "EEXIST")) throw error;
  }
  return true;
}

export async function listRuns(runsDir: string, historyOnly = false): Promise<RunMeta[]> {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(runsDir);
  } catch {
    return [];
  }
  const metas = await Promise.all(
    entries.map(async (entry) => {
      const dir = await runDirectory(entry, runsDir);
      if (!dir) return undefined;
      if (historyOnly && await fs.lstat(path.join(dir, HIDDEN_FROM_HISTORY)).catch(() => null)) return undefined;
      const meta = await readRunJson<RunMeta>(dir, "run.json");
      return meta && meta.id === entry ? meta : undefined;
    }),
  );
  return metas
    .filter((m): m is RunMeta => Boolean(m))
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
}

export async function loadRun(runId: string, runsDir: string): Promise<RunSummary | undefined> {
  const dir = await runDirectory(runId, runsDir);
  if (!dir) return undefined;
  const meta = await readRunJson<RunMeta>(dir, "run.json");
  if (!meta || meta.id !== runId) return undefined;
  const conclusion = await readRunJson<Conclusion>(dir, "conclusion.json");
  const decomposition = await readRunJson<Decomposition>(dir, "decomposition.json");
  const analyses = await readRunJson<Analysis[]>(dir, "analysis/index.json");
  const files = await listRunFiles(dir);
  return { meta, conclusion, decomposition, analyses, files };
}

export async function listRunFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string, rel: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= 1000) return;
      if (IGNORE_FILES.has(entry.name) || entry.name.startsWith(".")) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(path.join(current, entry.name), childRel);
      } else if (entry.isFile()) {
        out.push(childRel);
      }
      if (out.length > 1000) return;
    }
  }
  await walk(dir, "");
  return out.sort();
}

export async function resolveRunFile(runDir: string, relative: string): Promise<string | undefined> {
  const parts = relative.replace(/\\/g, "/").split("/");
  if (parts.some((part) => !part || part.startsWith(".") || /[:\0]/.test(part))) return undefined;
  try {
    const realRoot = await fs.realpath(runDir);
    const file = path.join(realRoot, ...parts);
    if (await fs.realpath(file) !== file) return undefined;
    const stat = await fs.stat(file);
    if (!stat.isFile()) return undefined;
    return file;
  } catch {
    return undefined;
  }
}

export async function readRunEvents(runDir: string, limit = 5000): Promise<unknown[]> {
  try {
    const filename = await resolveRunFile(runDir, "events.ndjson");
    if (!filename) return [];
    const file = await fs.open(filename, "r");
    let raw: string;
    let offset: number;
    try {
      const { size } = await file.stat();
      const length = Math.min(size, 8 * 1024 * 1024);
      offset = size - length;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await file.read(buffer, 0, length, offset);
      raw = buffer.subarray(0, bytesRead).toString("utf8");
    } finally { await file.close(); }
    // The bounded tail may begin in the middle of an event.
    if (offset > 0) raw = raw.slice(raw.indexOf("\n") + 1);
    const lines = raw.split("\n").filter(Boolean);
    const selected = lines.slice(-limit);
    const events: unknown[] = [];
    for (const line of selected) {
      try {
        events.push(JSON.parse(line));
      } catch {
        // ignore a partially written last line
      }
    }
    return events;
  } catch {
    return [];
  }
}
