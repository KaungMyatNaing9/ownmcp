import type { HttpMethod, JsonSchema, SpecOperation, ToolParam } from "../model/types.ts";
import { sameOrigin } from "./http.ts";

export interface ParsedForms {
  operations: SpecOperation[];
  notes: string[];
}

function decode(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function parseAttrs(tag: string): Record<string, string | true> {
  const attrs: Record<string, string | true> = {};
  const inner = tag.replace(/^<\w+\b/i, "").replace(/\/?>$/, "");
  const attrRe = /([^\s=/<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of inner.matchAll(attrRe)) {
    const key = (match[1] ?? "").toLowerCase();
    if (!key) continue;
    if (match[2] !== undefined) attrs[key] = decode(match[2]);
    else if (match[3] !== undefined) attrs[key] = decode(match[3]);
    else if (match[4] !== undefined) attrs[key] = decode(match[4]);
    else attrs[key] = true;
  }
  return attrs;
}

function textContent(html: string): string {
  return decode(html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function stripNoise(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
}

function labelMap(formHtml: string): Map<string, string> {
  const labels = new Map<string, string>();
  for (const match of formHtml.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/gi)) {
    const attrs = parseAttrs(`<label${match[1] ?? ""}>`);
    const withoutControls = (match[2] ?? "")
      .replace(/<(input|select|textarea)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<(input|select|textarea)\b[^>]*>/gi, " ");
    const text = textContent(withoutControls);
    if (typeof attrs.for === "string" && text) labels.set(attrs.for, text);
  }
  return labels;
}

function fieldSchema(tag: string, attrs: Record<string, string | true>, inner: string, label: string | undefined): JsonSchema {
  const description = typeof attrs.toolparamdescription === "string" ? attrs.toolparamdescription : label;
  const schema: JsonSchema = {};
  if (description) schema.description = description;
  const type = typeof attrs.type === "string" ? attrs.type.toLowerCase() : "text";
  if (tag === "textarea") {
    schema.type = "string";
    return schema;
  }
  if (tag === "select") {
    const values: string[] = [];
    for (const option of inner.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)) {
      const optionAttrs = parseAttrs(`<option${option[1] ?? ""}>`);
      const value = typeof optionAttrs.value === "string" ? optionAttrs.value : textContent(option[2] ?? "");
      if (value) values.push(value);
    }
    schema.type = "string";
    if (values.length > 0) schema.enum = values;
    return schema;
  }
  if (type === "checkbox") {
    schema.type = "boolean";
    return schema;
  }
  if (type === "number" || type === "range") {
    schema.type = "number";
    if (typeof attrs.min === "string" && attrs.min !== "" && !Number.isNaN(Number(attrs.min))) schema.minimum = Number(attrs.min);
    if (typeof attrs.max === "string" && attrs.max !== "" && !Number.isNaN(Number(attrs.max))) schema.maximum = Number(attrs.max);
    return schema;
  }
  schema.type = "string";
  if (type === "email") schema.format = "email";
  return schema;
}

function resolveAction(action: string, pagePath: string, owner: URL, notes: string[]): string | undefined {
  if (!action) return pagePath.startsWith("/") ? pagePath : "/";
  if (action.startsWith("javascript:") || action.startsWith("data:")) {
    notes.push(`Skipped a form whose action is ${action.split(":")[0]}:`);
    return undefined;
  }
  try {
    const url = new URL(action, owner.origin + (pagePath.startsWith("/") ? pagePath : "/"));
    if (!sameOrigin(url, owner) && url.origin !== owner.origin) {
      if (url.hostname !== owner.hostname) {
        notes.push(`Skipped a form that posts to ${url.origin}, which is not the declared owner origin.`);
        return undefined;
      }
    }
    if (url.origin !== owner.origin && url.hostname !== owner.hostname) return undefined;
    if (url.origin !== owner.origin) {
      notes.push(`Form action ${url.origin} uses a different loopback port and was kept as ${url.pathname}.`);
    }
    return url.pathname === "/" ? "/" : url.pathname.replace(/\/$/, "");
  } catch {
    notes.push("Skipped a form whose action did not parse.");
    return undefined;
  }
}

export function parseForms(html: string, owner: URL, pagePath = "/"): ParsedForms {
  const notes: string[] = [];
  const source = stripNoise(html);
  const operations: SpecOperation[] = [];
  const formRe = /<form\b[^>]*>/gi;
  for (const match of source.matchAll(formRe)) {
    const start = match.index ?? 0;
    const end = source.toLowerCase().indexOf("</form>", start);
    if (end < 0) {
      notes.push("Skipped an unclosed form.");
      continue;
    }
    const formHtml = source.slice(start, end + "</form>".length);
    const open = match[0] ?? "";
    const attrs = parseAttrs(open);
    const methodName = (typeof attrs.method === "string" ? attrs.method : "get").toUpperCase();
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(methodName)) continue;
    const method = methodName as HttpMethod;
    const action = typeof attrs.action === "string" ? attrs.action : "";
    const path = resolveAction(action, pagePath, owner, notes);
    if (!path) continue;
    const labels = labelMap(formHtml);
    const params: ToolParam[] = [];
    const controlRe = /<(input|select|textarea)\b[^>]*>/gi;
    for (const control of formHtml.matchAll(controlRe)) {
      const tag = (control[1] ?? "").toLowerCase();
      const tagAttrs = parseAttrs(control[0] ?? "");
      const inputType = typeof tagAttrs.type === "string" ? tagAttrs.type.toLowerCase() : "";
      if (["submit", "button", "reset", "image"].includes(inputType)) continue;
      if (typeof tagAttrs.name !== "string" || tagAttrs.name === "") {
        notes.push(`Skipped a ${tag} without a name in the form for ${method} ${path}.`);
        continue;
      }
      let inner = "";
      if (tag === "select") {
        const from = (control.index ?? 0) + (control[0]?.length ?? 0);
        const selectEnd = formHtml.toLowerCase().indexOf("</select>", from);
        inner = selectEnd >= 0 ? formHtml.slice(from, selectEnd) : "";
      }
      const id = typeof tagAttrs.id === "string" ? tagAttrs.id : "";
      params.push({
        name: tagAttrs.name,
        located: method === "GET" ? "query" : "body",
        required: tagAttrs.required === true || tagAttrs.required === "required" || tagAttrs.required === "",
        schema: fieldSchema(tag, tagAttrs, inner, id ? labels.get(id) : undefined),
      });
    }
    const toolName = typeof attrs.toolname === "string" ? attrs.toolname : undefined;
    const toolDescription = typeof attrs.tooldescription === "string" ? attrs.tooldescription : undefined;
    operations.push({
      source: "form",
      method,
      path,
      ...(toolName ? { operationId: toolName } : {}),
      ...(toolDescription ? { summary: toolDescription } : {}),
      params,
      bodyStyle: method === "GET" ? "none" : "form",
    });
  }
  return { operations, notes };
}
