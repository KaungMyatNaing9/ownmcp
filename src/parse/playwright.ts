import type { CallSample } from "../model/types.ts";
import { callFromRequest, type ParsedCalls } from "./http.ts";
import { readZip } from "./zip.ts";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function linesOf(text: string): unknown[] {
  const values: unknown[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      values.push(JSON.parse(trimmed) as unknown);
    } catch {
      // Trace files also contain non-JSON chunks. Skip those lines.
    }
  }
  return values;
}

function resourceText(files: Map<string, Buffer>, sha: string): string | undefined {
  const direct = files.get(`resources/${sha}`) ?? files.get(sha);
  if (direct) return direct.toString("utf8");
  for (const [name, data] of files) {
    if (name.endsWith(`/${sha}`) || name.endsWith(sha)) return data.toString("utf8");
  }
  return undefined;
}

export function parsePlaywrightTrace(buffer: Buffer, owner: URL): ParsedCalls & { files: string[] } {
  const files = readZip(buffer);
  const calls: CallSample[] = [];
  let dropped = 0;
  let ignoredNonHttp = 0;
  const seen = new Set<string>();

  for (const [name, data] of files) {
    if (!name.endsWith(".network") && !name.endsWith(".trace") && !name.endsWith(".har")) continue;
    for (const event of linesOf(data.toString("utf8"))) {
      const record = asRecord(event);
      if (!record || record.type !== "resource-snapshot") continue;
      const snapshot = asRecord(record.snapshot);
      const request = asRecord(snapshot?.request);
      const response = asRecord(snapshot?.response);
      if (!request || typeof request.url !== "string") continue;
      const method = typeof request.method === "string" ? request.method : "GET";
      const post = asRecord(request.postData);
      let text = typeof post?.text === "string" ? post.text : undefined;
      if (!text && typeof post?._sha1 === "string") text = resourceText(files, post._sha1);
      const status = typeof response?.status === "number" ? response.status : undefined;
      const key = `${method} ${request.url} ${text ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const result = callFromRequest({
        source: "playwright",
        method,
        url: request.url,
        queryString: request.queryString,
        headers: request.headers,
        mime: typeof post?.mimeType === "string" ? post.mimeType : undefined,
        text,
        params: post?.params,
        status,
        owner,
      });
      if (result.call) calls.push(result.call);
      else if (result.dropped) dropped += 1;
      else if (result.ignored) ignoredNonHttp += 1;
    }
  }

  return {
    calls,
    dropped,
    ignoredNonHttp,
    files: [...files.keys()],
    notes: [],
  };
}
