import { ANNOTATION_KEYS, WEBMCP_MODEL_CONTEXT_EXPRESSION, WEBMCP_REGISTER_METHOD } from "../api/surface.ts";
import { isHardToUndo } from "../infer/build.ts";
import type { JsonSchema, OwnedTool } from "../model/types.ts";

export interface RenderedProject {
  "tools.ts": string;
  "tools.test.ts": string;
  "browser.js": string;
  "REVIEW.md": string;
  "manifest.json": string;
}

function pascal(name: string): string {
  return `${name[0]?.toUpperCase() ?? ""}${name.slice(1)}`;
}

function embed(value: unknown, indent: number): string {
  const pad = " ".repeat(indent);
  return JSON.stringify(value, null, 2).replaceAll("\n", `\n${pad}`);
}

function inputSchema(tool: OwnedTool): { type: "object"; properties: Record<string, JsonSchema>; required?: string[] } {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const param of tool.params) {
    properties[param.name] = param.schema;
    if (param.required) required.push(param.name);
  }
  return required.length > 0 ? { type: "object", properties, required } : { type: "object", properties };
}

function renderExecute(tool: OwnedTool): string {
  const lines: string[] = [];
  if (tool.effect === "state-changing") {
    lines.push(
      `await requireConfirmation(${JSON.stringify(tool.effect)}, ${JSON.stringify(tool.name)}, input, options.confirm);`,
    );
  }
  lines.push(`const url = ownerUrl(options.baseUrl, fillPath(${JSON.stringify(tool.path)}, input));`);
  for (const param of tool.params.filter((item) => item.located === "query")) {
    const key = JSON.stringify(param.name);
    lines.push(`if (input[${key}] !== undefined) url.searchParams.set(${key}, String(input[${key}]));`);
  }
  const bodyParams = tool.params.filter((item) => item.located === "body");
  const init = [`method: ${JSON.stringify(tool.method)},`, "signal: agent?.signal,"];
  if (tool.method !== "GET" && tool.bodyStyle === "json" && bodyParams.length > 0) {
    const object = bodyParams
      .map((param) => `${JSON.stringify(param.name)}: input[${JSON.stringify(param.name)}]`)
      .join(", ");
    init.unshift(`headers: { accept: "application/json", "content-type": "application/json" },`);
    init.push(`body: JSON.stringify({ ${object} }),`);
  } else if (tool.method !== "GET" && tool.bodyStyle === "form" && bodyParams.length > 0) {
    lines.push("const form = new URLSearchParams();");
    for (const param of bodyParams) {
      const key = JSON.stringify(param.name);
      lines.push(`if (input[${key}] !== undefined) form.set(${key}, String(input[${key}]));`);
    }
    init.unshift(`headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },`);
    init.push("body: form,");
  } else {
    init.unshift(`headers: { accept: "application/json" },`);
  }
  lines.push("const response = await fetch(url, {");
  for (const field of init) lines.push(`  ${field}`);
  lines.push("});");
  lines.push("return readResponse(response);");
  return lines.map((line) => `        ${line}`).join("\n");
}

function renderTool(tool: OwnedTool, lang: "ts" | "js"): string {
  const inputType = lang === "ts" ? "input: Record<string, unknown>" : "input";
  const agentType = lang === "ts" ? "agent?: { signal?: AbortSignal }" : "agent";
  const schema = embed(inputSchema(tool), 8);
  return `    {
      name: ${JSON.stringify(tool.name)},
      title: ${JSON.stringify(tool.title)},
      description: ${JSON.stringify(tool.description)},
      inputSchema: ${schema},
      annotations: {
        ${ANNOTATION_KEYS.readOnlyHint}: ${tool.effect === "read"},
        ${ANNOTATION_KEYS.untrustedContentHint}: false,
        ${ANNOTATION_KEYS.consequentialHint}: ${tool.effect !== "read"},
        ${ANNOTATION_KEYS.debugging}: false,
      },
      async execute(${inputType}, ${agentType}) {
${renderExecute(tool)}
      },
    }`;
}

function renderReadResponse(lang: "ts" | "js"): string {
  if (lang === "ts") {
    return `async function readResponse(response: Response): Promise<{ ok: boolean; status: number; body: unknown }> {
  const text = await response.text();
  let body: unknown = text;
  if (text) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      // The app answered with text. Keep it on body.
    }
  } else {
    body = null;
  }
  return { ok: response.ok, status: response.status, body };
}`;
  }
  return `async function readResponse(response) {
  const text = await response.text();
  let body = text;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      // The app answered with text. Keep it on body.
    }
  } else {
    body = null;
  }
  return { ok: response.ok, status: response.status, body };
}`;
}

function renderPageRuntime(): string {
  return `class ConfirmationRequiredError extends Error {
  constructor(toolName) {
    super("Refusing to run state-changing tool \\"" + toolName + "\\" until confirm() returns true.");
    this.name = "ConfirmationRequiredError";
    this.toolName = toolName;
  }
}

async function requireConfirmation(effect, name, input, confirm) {
  if (effect === "read") return;
  if (!confirm) throw new ConfirmationRequiredError(name);
  const allowed = await confirm({ name, input });
  if (allowed !== true) throw new ConfirmationRequiredError(name);
}

function fillPath(template, input) {
  if (!template.startsWith("/") || template.startsWith("//") || template.includes("..") || template.includes("\\\\")) {
    throw new Error("Refusing an unsafe path template");
  }
  const missing = [];
  const filled = template.replace(/\\{([A-Za-z0-9_]+)\\}/g, (_match, name) => {
    const value = input[name];
    if (value === undefined || value === null || value === "") {
      missing.push(name);
      return "";
    }
    return encodeURIComponent(String(value));
  });
  if (missing.length) throw new Error("Missing path parameter " + missing.join(", "));
  return filled;
}

function ownerUrl(baseUrl, path) {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("..") || path.includes("\\\\")) {
    throw new Error("Refusing an unsafe path");
  }
  const base = new URL(baseUrl);
  if (base.protocol !== "http:" && base.protocol !== "https:") throw new Error("baseUrl must be http or https");
  const url = new URL(path, base.origin);
  if (url.origin !== base.origin) throw new Error("Refusing to leave the owner origin");
  return url;
}`;
}

function header(origin: string, sources: string[]): string {
  return `/**
 * Generated by ownmcp. Review every tool before shipping it.
 * Declared owner origin: ${origin}
 * Inputs: ${sources.length ? sources.join(", ") : "none"}
 *
 * State-changing tools call requireConfirmation() and do not send the request
 * unless confirm() returns true. consequentialHint asks a WebMCP client to
 * prompt; the 13 November 2026 draft does not enforce that prompt itself.
 * This milestone sets consequentialHint on every mutation. Clear it for a
 * reversible action if you want a quieter agent.
 */`;
}

function renderModule(name: string, origin: string, sources: string[], tools: readonly OwnedTool[]): string {
  const typeName = `${pascal(name)}Options`;
  const toolsLiteral = tools.map((tool) => renderTool(tool, "ts")).join(",\n");
  return `${header(origin, sources)}
import { fillPath, ownerUrl, registerOwnedTools, requireConfirmation } from "ownmcp";
import type { ConfirmFn, ModelContextLike, WebMcpTool } from "ownmcp";

export interface ${typeName} {
  baseUrl: string;
  confirm?: ConfirmFn;
}

export function create${pascal(name)}Tools(options: ${typeName}): WebMcpTool[] {
  return [
${toolsLiteral}
  ];
}

export async function register${pascal(name)}Tools(
  options: ${typeName} & { context?: ModelContextLike; signal?: AbortSignal },
): Promise<ModelContextLike> {
  return registerOwnedTools(create${pascal(name)}Tools(options), {
    context: options.context,
    signal: options.signal,
  });
}

${renderReadResponse("ts")}
`;
}

function renderTest(name: string, tools: readonly OwnedTool[]): string {
  const factory = `create${pascal(name)}Tools`;
  const register = `register${pascal(name)}Tools`;
  const changing = tools.filter((tool) => tool.effect === "state-changing").map((tool) => tool.name);
  const reads = tools.filter((tool) => tool.effect === "read");
  const writes = [
    ...tools.filter((tool) => tool.effect === "state-changing" && !isHardToUndo(tool.method, tool.name, tool.path)),
    ...tools.filter((tool) => isHardToUndo(tool.method, tool.name, tool.path)),
  ];
  const samples = Object.fromEntries(tools.map((tool) => [tool.name, tool.sample]));
  const live = [...reads, ...writes].filter((tool) => tool.sampleReady).map((tool) => tool.name);
  return `import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryModelContext } from "ownmcp";
import { ${factory}, ${register} } from "./tools.ts";

const baseUrl = process.env.OWNMCP_BASE_URL ?? "";
const samples = ${embed(samples, 0)} as const;

test("read and state-changing tools are labeled", () => {
  const tools = ${factory}({ baseUrl: "http://127.0.0.1:9", confirm: async () => false });
  for (const tool of tools) {
    assert.equal(tool.annotations?.debugging, false);
    assert.equal(tool.annotations?.untrustedContentHint, false);
    if (${JSON.stringify(changing)}.includes(tool.name)) {
      assert.equal(tool.annotations?.readOnlyHint, false);
      assert.equal(tool.annotations?.consequentialHint, true);
    } else {
      assert.equal(tool.annotations?.readOnlyHint, true);
      assert.equal(tool.annotations?.consequentialHint, false);
    }
  }
});

test("state-changing tools refuse to run without confirmation", async () => {
  const tools = ${factory}({ baseUrl: "http://127.0.0.1:9", confirm: async () => false });
  for (const name of ${JSON.stringify(changing)}) {
    const tool = tools.find((item) => item.name === name);
    assert.ok(tool, name);
    await assert.rejects(
      async () => {
        await tool.execute({ ...samples[name as keyof typeof samples] }, {});
      },
      (error: unknown) => error instanceof Error && error.name === "ConfirmationRequiredError",
    );
  }
});

test("generated tools call the owner app", { skip: baseUrl ? false : "Set OWNMCP_BASE_URL to the running app" }, async () => {
  const context = createMemoryModelContext();
  await ${register}({ baseUrl, confirm: async () => true, context });
  const registered = await context.getTools();
  for (const name of ${JSON.stringify(live)}) {
    const tool = registered.find((item) => item.name === name);
    assert.ok(tool, name);
    const raw = await context.executeTool(tool, { ...samples[name as keyof typeof samples] });
    const result = JSON.parse(raw) as { ok?: boolean; status?: number; body?: unknown };
    assert.equal(result.ok, true, name + " " + JSON.stringify(result));
  }
});
`;
}

function renderBrowser(name: string, origin: string, sources: string[], tools: readonly OwnedTool[]): string {
  const toolsLiteral = tools.map((tool) => renderTool(tool, "js")).join(",\n");
  return `${header(origin, sources)}
"use strict";
${renderPageRuntime()}
${renderReadResponse("js")}

function create${pascal(name)}Tools(options) {
  return [
${toolsLiteral}
  ];
}

async function registerGeneratedTools(options) {
  const resolved = options || {
    baseUrl: location.origin,
    confirm(request) {
      return window.confirm("Allow " + request.name + " to change data on this page?");
    },
  };
  const status = document.getElementById("agent-tools-status");
  const list = document.getElementById("agent-tools-list");
  const modelContext = ${WEBMCP_MODEL_CONTEXT_EXPRESSION};
  const tools = create${pascal(name)}Tools(resolved);
  if (!modelContext || typeof modelContext.${WEBMCP_REGISTER_METHOD} !== "function") {
    if (status) {
      status.textContent = "This browser has no ${WEBMCP_MODEL_CONTEXT_EXPRESSION}. Chrome 157 exposed it with --enable-features=WebMCP. The forms still work.";
    }
    return tools;
  }
  for (const tool of tools) {
    const item = document.createElement("li");
    const effect = tool.annotations.${ANNOTATION_KEYS.readOnlyHint} ? "read" : "state-changing, confirmation required";
    try {
      await modelContext.${WEBMCP_REGISTER_METHOD}(tool);
      item.textContent = tool.name + " — " + effect;
    } catch (error) {
      const message = error && error.name === "InvalidStateError"
        ? "already registered, so this script left the existing one in place"
        : "failed to register";
      item.textContent = tool.name + " — " + message;
    }
    if (list) list.appendChild(item);
  }
  if (status) status.textContent = "Registered WebMCP tools for this page.";
  return tools;
}

if (!globalThis.__OWNMCP_NO_AUTORUN) {
  registerGeneratedTools().catch((error) => {
    const status = document.getElementById("agent-tools-status");
    if (status) status.textContent = "WebMCP registration failed: " + (error && error.message ? error.message : error);
  });
}
`;
}

function renderReview(origin: string, notes: string[], tools: readonly OwnedTool[]): string {
  const lines = [
    "# Review these tools before shipping",
    "",
    `Declared owner origin: \`${origin}\`.`,
    "",
    "ownmcp only turns recordings, forms, and OpenAPI that you point it at into `registerTool` handlers for that origin. It does not crawl other sites.",
    "",
    ...notes.map((note) => `- ${note}`),
    "",
  ];
  for (const tool of tools) {
    lines.push(`## ${tool.name}`);
    lines.push("");
    lines.push(`- Effect: **${tool.effect}**`);
    lines.push(`- Confirmation: ${tool.effect === "read" ? "not required" : "required before the request is sent"}`);
    lines.push(`- Call: \`${tool.method} ${tool.path}\``);
    lines.push(`- Sources: ${tool.sources.join(", ") || "none"}`);
    lines.push(`- consequentialHint: ${tool.effect === "state-changing" ? "true" : "false"}`);
    lines.push(`- readOnlyHint: ${tool.effect === "read" ? "true" : "false"}`);
    if (!tool.sampleReady) lines.push("- The generated live test skips this tool because a required field has no sample.");
    for (const note of tool.reviewNotes) lines.push(`- ${note}`);
    lines.push("");
  }
  lines.push("untrustedContentHint is false on every generated tool. Set it to true if a response includes content your site does not control.");
  lines.push("");
  return lines.join("\n");
}

export function renderProject(options: {
  name: string;
  origin: string;
  sources: string[];
  notes: string[];
  tools: readonly OwnedTool[];
  dropped: number;
  skippedStatic: number;
}): RenderedProject {
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(options.name)) {
    throw new Error("--name must be a letter followed by letters or digits");
  }
  const notes = [...options.notes];
  if (options.dropped > 0) {
    const noun = options.dropped === 1 ? "request" : "requests";
    notes.push(`Dropped ${options.dropped} ${noun} whose origin was not ${options.origin}.`);
  }
  if (options.skippedStatic > 0) {
    const noun = options.skippedStatic === 1 ? "request" : "requests";
    notes.push(`Skipped ${options.skippedStatic} static or discovery ${noun}. Those are not tools.`);
  }
  const manifest = {
    name: options.name,
    origin: options.origin,
    tools: options.tools.map((tool) => ({
      name: tool.name,
      effect: tool.effect,
      confirmation: tool.effect === "read" ? "not-required" : "required",
      method: tool.method,
      path: tool.path,
      sources: tool.sources,
      reviewNotes: tool.reviewNotes,
    })),
    notes,
  };
  return {
    "tools.ts": renderModule(options.name, options.origin, options.sources, options.tools),
    "tools.test.ts": renderTest(options.name, options.tools),
    "browser.js": renderBrowser(options.name, options.origin, options.sources, options.tools),
    "REVIEW.md": renderReview(options.origin, notes, options.tools),
    "manifest.json": `${JSON.stringify(manifest, null, 2)}\n`,
  };
}
