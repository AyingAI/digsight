import type { IncomingMessage } from "node:http";

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** A local UI can drive a logged-in browser: reject DNS rebinding and cross-site writes. */
export function validateRequest(req: IncomingMessage): void {
  const port = req.socket.localPort;
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  const host = req.headers.host?.toLowerCase();
  if (!host || !allowedHosts.has(host)) throw new HttpError(403, "仅允许通过本机地址访问 DIGSIGHT。");
  if (req.headers["sec-fetch-site"] === "cross-site") throw new HttpError(403, "不允许跨站访问本地工作台。");
  if (req.headers.origin && req.headers.origin !== `http://${host}`) {
    throw new HttpError(403, "不允许跨站访问本地工作台。");
  }
  if (req.method === "POST" && req.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") {
    throw new HttpError(415, "请求必须使用 application/json。");
  }
}

export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 64 * 1024) throw new HttpError(413, "请求内容过大（最多 64 KB）。");
    chunks.push(buffer);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new HttpError(400, "请求不是合法的 JSON。");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "请求必须是 JSON 对象。");
  return value as Record<string, unknown>;
}
