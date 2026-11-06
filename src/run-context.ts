import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  EventStatus,
  EventType,
  ProgressEvent,
  RunMeta,
  RunOptions,
  RunStatus,
} from "./types.ts";
import { ensureDir, makeRunId, nowIso, stripAnsi, writeJson, writeText } from "./util.ts";

type EmitInput = {
  type: EventType;
  status?: EventStatus;
  phase?: string;
  subQuestionId?: string;
  engine?: ProgressEvent["engine"];
  message: string;
  data?: unknown;
};

/**
 * A run owns its directory, metadata, event stream and cancellation signal.
 * It is deliberately independent of the CLI/server so both can drive it.
 */
export class RunContext {
  readonly id: string;
  readonly dir: string;
  readonly signal: AbortSignal;
  meta: RunMeta;
  events: ProgressEvent[] = [];
  keepPages = false;

  #seq = 0;
  #controller = new AbortController();
  #subscribers = new Set<(event: ProgressEvent) => void>();
  #writeChain: Promise<void> = Promise.resolve();
  #metaWriteChain: Promise<void> = Promise.resolve();

  constructor(meta: RunMeta, dir: string) {
    this.meta = meta;
    this.id = meta.id;
    this.dir = dir;
    this.signal = this.#controller.signal;
  }

  static async create(options: RunOptions, baseDir?: string): Promise<RunContext> {
    const id = makeRunId(options.question);
    const root = baseDir || options.runsDir;
    await ensureDir(root);
    const dir = path.join(root, id);
    await fs.mkdir(dir, { mode: 0o700 });
    const meta: RunMeta = {
      id,
      question: options.question,
      options,
      status: "queued",
      phase: "init",
      createdAt: nowIso(),
      counts: {
        subQuestions: 0,
        engines: options.engines.length,
        materialsOk: 0,
        materialsFailed: 0,
        citationsChecked: 0,
        citationsOk: 0,
      },
    };
    const ctx = new RunContext(meta, dir);
    await writeJson(path.join(dir, "run.json"), meta);
    await writeText(path.join(dir, "question.md"), `# 调研问题\n\n${options.question}\n`);
    await fs.writeFile(path.join(dir, "events.ndjson"), "", { mode: 0o600 });
    ctx.emit({ type: "run", status: "info", phase: "init", message: "运行已创建", data: { options } });
    return ctx;
  }

  static load(meta: RunMeta, dir: string): RunContext {
    return new RunContext(meta, dir);
  }

  path(...parts: string[]): string {
    return path.join(this.dir, ...parts);
  }

  emit(input: EmitInput): ProgressEvent {
    const event: ProgressEvent = {
      seq: ++this.#seq,
      ts: nowIso(),
      runId: this.id,
      ...input,
      message: stripAnsi(input.message),
    };
    this.events.push(event);
    if (this.events.length > 5000) this.events.splice(0, this.events.length - 5000);
    for (const fn of this.#subscribers) {
      try {
        fn(event);
      } catch {
        // A broken UI subscriber must not break the research run.
      }
    }
    const line = JSON.stringify(event) + "\n";
    this.#writeChain = this.#writeChain
      .then(() => fs.appendFile(path.join(this.dir, "events.ndjson"), line, "utf8"))
      .catch(() => {});
    return event;
  }

  subscribe(fn: (event: ProgressEvent) => void): () => void {
    this.#subscribers.add(fn);
    return () => this.#subscribers.delete(fn);
  }

  async update(patch: Partial<RunMeta>): Promise<void> {
    this.meta = { ...this.meta, ...patch, counts: patch.counts ?? this.meta.counts };
    const snapshot = this.meta;
    const write = this.#metaWriteChain.then(() => writeJson(path.join(this.dir, "run.json"), snapshot));
    this.#metaWriteChain = write.catch(() => {});
    await write;
  }

  async setStatus(status: RunStatus, phase?: string, error?: string): Promise<void> {
    const patch: Partial<RunMeta> = { status };
    if (phase) patch.phase = phase;
    if (error !== undefined) patch.error = error;
    if (status === "running" && !this.meta.startedAt) {
      patch.startedAt = nowIso();
    }
    if (status === "completed" || status === "failed" || status === "cancelled") {
      patch.finishedAt = nowIso();
      if (this.meta.startedAt) {
        patch.durationMs = Date.now() - new Date(this.meta.startedAt).getTime();
      }
    }
    await this.update(patch);
  }

  cancel(): void {
    if (!this.#controller.signal.aborted) this.#controller.abort();
  }

  get cancelled(): boolean {
    return this.#controller.signal.aborted;
  }

  throwIfCancelled(): void {
    if (this.cancelled) throw new Error("cancelled");
  }

  async flushEvents(): Promise<void> {
    await this.#writeChain;
  }

  async writeJson(rel: string, data: unknown): Promise<string> {
    const file = this.path(rel);
    await writeJson(file, data);
    return file;
  }

  async writeText(rel: string, text: string): Promise<string> {
    const file = this.path(rel);
    await writeText(file, text);
    return file;
  }
}
