import { lookup } from "node:dns/promises";
import { addAbortListener } from "node:events";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import type { CitationCheck } from "./types.ts";
import { isPublicResearchUrl, nowIso, redactWebSecrets } from "./util.ts";

// IANA special-purpose ranges, plus multicast and reserved address space.
const nonPublic = new BlockList();
for (const [address, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3],
] as const) nonPublic.addSubnet(address, bits);
for (const [address, bits] of [
  ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20],
] as const) nonPublic.addSubnet(address, bits, "ipv6");
const globalUnicast = new BlockList();
globalUnicast.addSubnet("2000::", 3, "ipv6");

export function isPublicAddress(address: string): boolean {
  switch (isIP(address)) {
    case 4: return !nonPublic.check(address);
    case 6: return globalUnicast.check(address, "ipv6") && !nonPublic.check(address, "ipv6");
    default: return false;
  }
}

async function resolvePublicAddress(hostname: string, signal: AbortSignal) {
  signal.throwIfAborted();
  let abort: ReturnType<typeof addAbortListener> | undefined;
  try {
    const addresses = await Promise.race([
      lookup(hostname, { all: true }),
      new Promise<never>((_, reject) => {
        abort = addAbortListener(signal, () => reject(signal.reason));
      }),
    ]);
    if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
      throw new Error("引用域名解析到非公开地址");
    }
    return addresses.find(({ family }) => family === 4) ?? addresses[0]!;
  } finally {
    abort?.[Symbol.dispose]();
  }
}

async function openPublicPage(url: URL, signal: AbortSignal): Promise<http.IncomingMessage> {
  if (!isPublicResearchUrl(url.href)) throw new Error("引用链接包含非公开地址或认证参数");
  const { address, family } = await resolvePublicAddress(url.hostname, signal);
  const request = url.protocol === "https:" ? https.get : http.get;
  return new Promise((resolve, reject) => {
    request(url, {
      signal,
      agent: false,
      family,
      // Keep the original hostname for Host and TLS. Connect to the checked address.
      lookup: (_hostname, _options, done) => done(null, address, family),
      headers: { Accept: "text/html,application/xhtml+xml,text/plain", "Accept-Encoding": "identity" },
      rejectUnauthorized: true,
    }, resolve).once("error", reject);
  });
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_RESPONSE_BYTES = 256 * 1024;

async function readExcerpt(response: http.IncomingMessage, charset: string): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response) {
    const remaining = MAX_RESPONSE_BYTES - size;
    const buffer = (chunk as Buffer).subarray(0, remaining);
    chunks.push(buffer);
    size += buffer.length;
    if (size >= MAX_RESPONSE_BYTES) break;
  }
  let decoder: TextDecoder;
  try { decoder = new TextDecoder(charset); } catch { decoder = new TextDecoder(); }
  return decoder.decode(Buffer.concat(chunks));
}

function summarizePage(text: string, html: boolean): { title?: string; excerpt: string } {
  const compact = (value: string) => value
    .replace(/&(?:nbsp|#160);/gi, " ").replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ").trim();
  if (!html) return { excerpt: compact(text).slice(0, 1500) };
  let title = "";
  let excerpt = "";
  let ignored = "";
  let inHead = false;
  for (const match of text.matchAll(/<!--[\s\S]*?(?:-->|$)|<(\/?)([a-z][\w:-]*)(?=[\s/>])[^<>]*>|[^<>]+|[<>]/gi)) {
    const token = match[0];
    if (token.startsWith("<!--")) continue;
    const tag = match[2]?.toLowerCase();
    if (tag) {
      const closing = match[1] === "/";
      if (ignored) {
        if (closing && tag === ignored) ignored = "";
      } else if (!closing && ["script", "style", "title", "template"].includes(tag)) {
        ignored = tag;
      } else if (tag === "head") {
        inHead = !closing;
      }
    } else if (ignored === "title") {
      title += token;
    } else if (!ignored && !inHead) {
      excerpt += ` ${token}`;
    }
  }
  return { title: compact(title).slice(0, 300) || undefined, excerpt: compact(excerpt).slice(0, 1500) };
}

export async function checkCitation(raw: string, signal: AbortSignal): Promise<CitationCheck> {
  const check: CitationCheck = { url: raw, checkedAt: nowIso(), ok: false };
  try {
    let url = new URL(raw);
    for (let redirects = 0; redirects <= 5; redirects++) {
      const response = await openPublicPage(url, signal);
      try {
        const status = response.statusCode ?? 0;
        if (REDIRECTS.has(status) && response.headers.location) {
          const target = new URL(response.headers.location, url);
          if (url.protocol === "https:" && target.protocol === "http:") throw new Error("引用重定向降低了 HTTPS 安全性");
          url = target;
          continue;
        }
        check.status = status;
        check.finalUrl = url.origin + url.pathname + url.search;
        if (status < 200 || status >= 300) throw new Error(`HTTP ${status}`);
        const type = response.headers["content-type"] ?? "";
        if (!/^(?:text\/(?:html|plain)|application\/xhtml\+xml)(?:\s*;|$)/i.test(type) ||
            ![undefined, "identity"].includes(response.headers["content-encoding"])) {
          throw new Error("页面未提供可直接读取的 HTML 或文本");
        }
        const charset = /charset\s*=\s*["']?([\w-]+)/i.exec(type)?.[1] ?? "utf-8";
        Object.assign(check, summarizePage(redactWebSecrets(await readExcerpt(response, charset)), !/^text\/plain/i.test(type)));
        if (!check.excerpt) throw new Error("页面没有可读取的正文");
        check.ok = true;
        return check;
      } finally {
        response.destroy();
      }
    }
    throw new Error("引用重定向次数超出限制");
  } catch (error) {
    // Keep DNS/TLS diagnostics and URLs from the underlying client out of saved artifacts.
    const message = (error as Error).message;
    check.error = signal.aborted ? "引用核查已停止或超时"
      : /^(引用|页面|HTTP )/.test(message) ? message : "无法读取公开引用";
    return check;
  }
}
