import type { CallSample } from "../model/types.ts";
import { callFromRequest, type ParsedCalls } from "./http.ts";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

export function parseHar(document: unknown, owner: URL): ParsedCalls {
  const root = asRecord(document);
  const log = asRecord(root?.log);
  const entries = log?.entries;
  if (!Array.isArray(entries)) throw new Error("HAR is missing log.entries");
  const calls: CallSample[] = [];
  let dropped = 0;
  let ignoredNonHttp = 0;
  for (const entry of entries) {
    const record = asRecord(entry);
    const request = asRecord(record?.request);
    const response = asRecord(record?.response);
    if (!request || typeof request.method !== "string" || typeof request.url !== "string") continue;
    const post = asRecord(request.postData);
    const status = typeof response?.status === "number" ? response.status : undefined;
    if (status === 0) continue;
    const result = callFromRequest({
      source: "har",
      method: request.method,
      url: request.url,
      queryString: request.queryString,
      headers: request.headers,
      mime: typeof post?.mimeType === "string" ? post.mimeType : undefined,
      text: typeof post?.text === "string" ? post.text : undefined,
      params: post?.params,
      status,
      owner,
    });
    if (result.call) calls.push(result.call);
    else if (result.dropped) dropped += 1;
    else if (result.ignored) ignoredNonHttp += 1;
  }
  return { calls, dropped, ignoredNonHttp, notes: [] };
}
