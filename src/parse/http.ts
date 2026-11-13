import type { BodyStyle, CallSample } from "../model/types.ts";

export interface ParsedCalls {
  calls: CallSample[];
  dropped: number;
  ignoredNonHttp: number;
  notes: string[];
}

export function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

export function originOf(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Not an origin: ${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("The owner origin must be http or https");
  }
  return url;
}

export function sameOrigin(url: URL, owner: URL): boolean {
  return url.origin === owner.origin;
}

interface LooseRecord {
  [key: string]: unknown;
}

function asRecord(value: unknown): LooseRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as LooseRecord;
}

function headerMap(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(headers)) {
    for (const header of headers) {
      const record = asRecord(header);
      if (!record) continue;
      const name = typeof record.name === "string" ? record.name : "";
      const value = typeof record.value === "string" ? record.value : "";
      if (name) out[name.toLowerCase()] = value;
    }
    return out;
  }
  const record = asRecord(headers);
  if (!record) return out;
  for (const [name, value] of Object.entries(record)) {
    if (typeof value === "string") out[name.toLowerCase()] = value;
  }
  return out;
}

function queryFromEntry(url: URL, queryString: unknown): Record<string, string> {
  const query: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    query[key] = value;
  });
  if (Array.isArray(queryString)) {
    for (const item of queryString) {
      const record = asRecord(item);
      if (!record || typeof record.name !== "string") continue;
      query[record.name] = typeof record.value === "string" ? record.value : "";
    }
  }
  return query;
}

export function formValues(text: string): Record<string, unknown> {
  const params = new URLSearchParams(text);
  const body: Record<string, unknown> = {};
  for (const [key, value] of params) body[key] = value;
  return body;
}

export function bodyFromPost(mime: string, text: string | undefined, params: unknown): {
  bodyStyle: BodyStyle;
  body?: Record<string, unknown>;
} {
  const type = mime.toLowerCase();
  if (Array.isArray(params) && params.length > 0) {
    const body: Record<string, unknown> = {};
    for (const item of params) {
      const record = asRecord(item);
      if (!record || typeof record.name !== "string") continue;
      body[record.name] = typeof record.value === "string" ? record.value : "";
    }
    return { bodyStyle: "form", body };
  }
  if (!text) return { bodyStyle: "none" };
  if (type.includes("application/json") || text.startsWith("{") || text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { bodyStyle: "json", body: parsed as Record<string, unknown> };
      }
    } catch {
      return { bodyStyle: "none" };
    }
  }
  if (type.includes("application/x-www-form-urlencoded")) {
    return { bodyStyle: "form", body: formValues(text) };
  }
  return { bodyStyle: "none" };
}

export function callFromRequest(options: {
  source: "har" | "playwright";
  method: string;
  url: string;
  queryString?: unknown;
  headers?: unknown;
  mime?: string;
  text?: string;
  params?: unknown;
  status?: number;
  owner: URL;
}): { call?: CallSample; dropped?: boolean; ignored?: boolean } {
  let url: URL;
  try {
    url = new URL(options.url);
  } catch {
    return { ignored: true };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ignored: true };
  if (!sameOrigin(url, options.owner)) return { dropped: true };
  const method = options.method.toUpperCase();
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) return {};
  const headers = headerMap(options.headers);
  const mime = options.mime || headers["content-type"] || "";
  const parsedBody = method === "GET" ? { bodyStyle: "none" as const } : bodyFromPost(mime, options.text, options.params);
  const pathname = url.pathname.length > 1 && url.pathname.endsWith("/")
    ? url.pathname.slice(0, -1)
    : url.pathname;
  return {
    call: {
      source: options.source,
      method,
      pathname,
      query: queryFromEntry(url, options.queryString),
      bodyStyle: parsedBody.bodyStyle,
      ...(parsedBody.body ? { body: parsedBody.body } : {}),
      ...(options.status !== undefined ? { status: options.status } : {}),
    },
  };
}
