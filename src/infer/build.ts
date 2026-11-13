import type {
  BodyStyle,
  BuildResult,
  CallSample,
  HttpMethod,
  JsonSchema,
  OwnedTool,
  SpecOperation,
  ToolEffect,
  ToolParam,
} from "../model/types.ts";

const METHODS = new Set<HttpMethod>(["GET", "POST", "PUT", "PATCH", "DELETE"]);

const DISCOVERY = new Set([
  "/",
  "/favicon.ico",
  "/favicon.svg",
  "/robots.txt",
  "/llms.txt",
  "/sitemap.xml",
  "/openapi.json",
  "/swagger.json",
  "/.well-known/ai-catalog.json",
]);

const STATIC_FILE = /\.(?:css|js|mjs|cjs|map|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|eot)$/i;

export function effectOf(method: string): ToolEffect {
  return method === "GET" || method === "HEAD" ? "read" : "state-changing";
}

export function isHardToUndo(method: string, name: string, path: string): boolean {
  if (method === "GET" || method === "HEAD") return false;
  if (method === "DELETE") return true;
  return /(checkout|purchase|payment|transfer|refund|delete|remove|place_order)/i.test(`${name} ${path}`);
}

function isMethod(value: string): value is HttpMethod {
  return METHODS.has(value as HttpMethod);
}

function skipCall(call: CallSample): boolean {
  if (STATIC_FILE.test(call.pathname)) return true;
  if ((call.method === "GET" || call.method === "HEAD") && DISCOVERY.has(call.pathname)) return true;
  return false;
}

function looksLikeId(segment: string): boolean {
  return (
    /^\d+$/.test(segment) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment) ||
    /^[0-9a-f]{16,}$/i.test(segment)
  );
}

function templatize(pathname: string): { path: string; params: Array<{ name: string; sample: string }> } {
  const params: Array<{ name: string; sample: string }> = [];
  const path = pathname
    .split("/")
    .map((segment, index) => {
      if (index === 0 || !looksLikeId(segment)) return segment;
      const name = params.length === 0 ? "id" : `id${params.length + 1}`;
      params.push({ name, sample: decodeURIComponent(segment) });
      return `{${name}}`;
    })
    .join("/");
  return { path, params };
}

function matchTemplate(template: string, pathname: string): Record<string, string> | undefined {
  const expected = template.split("/");
  const actual = pathname.split("/");
  if (expected.length !== actual.length) return undefined;
  const params: Record<string, string> = {};
  for (let index = 0; index < expected.length; index += 1) {
    const left = expected[index] ?? "";
    const right = actual[index] ?? "";
    if (left.startsWith("{") && left.endsWith("}")) params[left.slice(1, -1)] = decodeURIComponent(right);
    else if (left !== right) return undefined;
  }
  return params;
}

function schemaFromValue(value: unknown): JsonSchema {
  if (typeof value === "boolean") return { type: "boolean" };
  if (typeof value === "number") return { type: Number.isInteger(value) ? "integer" : "number" };
  if (typeof value === "string") return { type: "string" };
  if (Array.isArray(value)) return { type: "array", items: value.length > 0 ? schemaFromValue(value[0]) : { type: "string" } };
  return { type: "string" };
}

function sanitize(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 128);
  return /^[A-Za-z0-9._-]{1,128}$/.test(cleaned) ? cleaned : "";
}

function uniqueName(name: string, used: Set<string>): string {
  if (!used.has(name)) return name;
  for (let index = 2; index < 1000; index += 1) {
    const suffix = `_${index}`;
    const next = `${name.slice(0, 128 - suffix.length)}${suffix}`;
    if (!used.has(next)) return next;
  }
  throw new Error(`Could not make a unique tool name from ${name}`);
}

function synthesizeName(method: string, path: string): string {
  const parts = path
    .split("/")
    .filter(Boolean)
    .map((part) => (part.startsWith("{") ? part.slice(1, -1) : part));
  return sanitize(`${method.toLowerCase()}_${parts.join("_")}`) || "tool";
}

function coerce(value: unknown, schema: JsonSchema): unknown {
  if (value === undefined || value === null) return undefined;
  if ((schema.type === "integer" || schema.type === "number") && typeof value === "string" && value.trim() !== "") {
    const number = Number(value);
    if (Number.isNaN(number)) return undefined;
    if (schema.type === "integer" && !Number.isInteger(number)) return undefined;
    return number;
  }
  if (schema.type === "boolean" && typeof value === "string") {
    if (value === "true" || value === "on") return true;
    if (value === "false" || value === "off") return false;
  }
  return value;
}

function titleFor(name: string, summary: string | undefined): string {
  if (summary) {
    const sentence = summary.split(/[.]/)[0]?.trim() ?? summary;
    if (sentence.length > 0 && sentence.length <= 80) return sentence;
    if (sentence.length > 80) return `${sentence.slice(0, 77)}...`;
  }
  return name
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function describe(summary: string | undefined, description: string | undefined, effect: ToolEffect, method: string, path: string): string {
  const fallback = effect === "read"
    ? `Read ${method} ${path} on this app.`
    : `Change state with ${method} ${path} on this app.`;
  const base = (summary || description || fallback).replace(/\s+/g, " ").trim();
  const suffix = effect === "read"
    ? "Read-only: it does not change app state."
    : "State-changing: the handler does not call the app unless confirm() returns true.";
  if (base.includes(suffix)) return `${base} The result is { ok, status, body }.`;
  return `${base} ${suffix} The result is { ok, status, body }.`;
}

interface BoundCall extends CallSample {
  pathParams: Record<string, string>;
}

interface Group {
  method: HttpMethod;
  path: string;
  ops: SpecOperation[];
  calls: BoundCall[];
}

function bestCall(calls: BoundCall[]): BoundCall | undefined {
  const succeeded = calls.filter((call) => call.status === undefined || (call.status >= 200 && call.status < 300));
  const pool = succeeded.length > 0 ? succeeded : calls;
  return pool[pool.length - 1];
}

export function buildTools(operations: SpecOperation[], calls: CallSample[], notes: string[]): BuildResult {
  const groups = new Map<string, Group>();
  let skippedStatic = 0;
  for (const operation of operations) {
    const key = `${operation.method} ${operation.path}`;
    const group = groups.get(key) ?? { method: operation.method, path: operation.path, ops: [], calls: [] };
    group.ops.push(operation);
    groups.set(key, group);
  }

  for (const call of calls) {
    if (!isMethod(call.method)) continue;
    if (skipCall(call)) {
      skippedStatic += 1;
      continue;
    }
    let found: { group: Group; pathParams: Record<string, string> } | undefined;
    for (const group of groups.values()) {
      if (group.method !== call.method) continue;
      const pathParams = matchTemplate(group.path, call.pathname);
      if (pathParams) {
        found = { group, pathParams };
        break;
      }
    }
    if (!found) {
      const templated = templatize(call.pathname);
      const key = `${call.method} ${templated.path}`;
      const group = groups.get(key) ?? { method: call.method, path: templated.path, ops: [], calls: [] };
      groups.set(key, group);
      const pathParams: Record<string, string> = {};
      for (const param of templated.params) pathParams[param.name] = param.sample;
      found = { group, pathParams };
    }
    found.group.calls.push({ ...call, pathParams: found.pathParams });
  }

  const used = new Set<string>();
  const tools: OwnedTool[] = [];
  for (const group of groups.values()) {
    const reviewNotes: string[] = [];
    const openapi = group.ops.find((operation) => operation.source === "openapi");
    const form = group.ops.find((operation) => operation.source === "form");
    const preferredId = openapi?.operationId || form?.operationId;
    if (openapi?.operationId && form?.operationId && sanitize(openapi.operationId) !== sanitize(form.operationId)) {
      reviewNotes.push(
        `The form toolname was ${form.operationId}. The generated name follows the OpenAPI operationId ${openapi.operationId}.`,
      );
    }
    const name = uniqueName(sanitize(preferredId || "") || synthesizeName(group.method, group.path), used);
    used.add(name);

    const params = new Map<string, ToolParam>();
    let bodyStyle: BodyStyle = "none";
    const ordered = [
      ...group.ops.filter((operation) => operation.source === "openapi"),
      ...group.ops.filter((operation) => operation.source === "form"),
    ];
    for (const operation of ordered) {
      if (operation.bodyStyle === "json") bodyStyle = "json";
      else if (operation.bodyStyle === "form" && bodyStyle !== "json") bodyStyle = "form";
      for (const param of operation.params) {
        if (params.has(param.name)) continue;
        params.set(param.name, param);
      }
    }
    if (ordered.some((operation) => operation.bodyStyle === "json") && ordered.some((operation) => operation.bodyStyle === "form")) {
      reviewNotes.push("A recording or form used a form body. The handler sends JSON because an OpenAPI application/json schema is present.");
    }

    const chosen = bestCall(group.calls);
    if (group.ops.length === 0 && chosen) {
      bodyStyle = chosen.bodyStyle;
      for (const paramName of Object.keys(chosen.pathParams)) {
        params.set(paramName, {
          name: paramName,
          located: "path",
          required: true,
          schema: { type: "string", description: "Path value observed in the recording." },
        });
      }
      for (const [paramName, value] of Object.entries(chosen.query)) {
        params.set(paramName, {
          name: paramName,
          located: "query",
          required: false,
          schema: schemaFromValue(value),
        });
      }
      for (const [paramName, value] of Object.entries(chosen.body ?? {})) {
        if (params.has(paramName)) continue;
        params.set(paramName, {
          name: paramName,
          located: "body",
          required: true,
          schema: schemaFromValue(value),
        });
      }
    } else if (chosen) {
      for (const [paramName, value] of Object.entries({ ...chosen.pathParams, ...chosen.query, ...(chosen.body ?? {}) })) {
        if (params.has(paramName)) continue;
        const located = paramName in chosen.pathParams ? "path" : paramName in chosen.query ? "query" : "body";
        params.set(paramName, {
          name: paramName,
          located,
          required: located === "path",
          schema: schemaFromValue(value),
        });
        reviewNotes.push(`Observed ${located} field ${paramName} was not declared in OpenAPI or the form.`);
      }
    }

    if (group.calls.some((call) => (call.status ?? 200) >= 400) && !group.calls.some((call) => call.status !== undefined && call.status < 400)) {
      reviewNotes.push("Every recorded call to this endpoint returned an HTTP error.");
    }

    const sample: Record<string, unknown> = {};
    for (const param of params.values()) {
      const raw = chosen
        ? param.located === "path"
          ? chosen.pathParams[param.name]
          : param.located === "query"
            ? chosen.query[param.name]
            : chosen.body?.[param.name]
        : undefined;
      const value = coerce(raw, param.schema);
      if (value !== undefined) sample[param.name] = value;
      else if (param.schema.default !== undefined) sample[param.name] = param.schema.default;
      else if (param.schema.enum && param.schema.enum.length > 0) sample[param.name] = param.schema.enum[0];
      else if (param.required && (param.schema.type === "integer" || param.schema.type === "number")) {
        sample[param.name] = param.schema.minimum ?? 1;
      }
    }
    const sampleReady = [...params.values()].filter((param) => param.required).every((param) => sample[param.name] !== undefined);
    const effect = effectOf(group.method);
    const summary = openapi?.summary || form?.summary;
    const description = openapi?.description || form?.description;
    const sources = [...new Set([...group.ops.map((operation) => operation.source), ...group.calls.map((call) => call.source)])].sort();
    if (effect === "state-changing" && isHardToUndo(group.method, name, group.path)) {
      reviewNotes.push("This looks hard to undo. Keep the confirmation gate.");
    }
    tools.push({
      name,
      title: titleFor(name, summary),
      description: describe(summary, description, effect, group.method, group.path),
      effect,
      method: group.method,
      path: group.path,
      params: [...params.values()],
      bodyStyle: effect === "read" ? "none" : bodyStyle,
      sample,
      sampleReady,
      sources,
      reviewNotes,
    });
  }

  tools.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { tools, notes, skippedStatic };
}
