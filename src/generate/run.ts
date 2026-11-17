import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { renderProject } from "./emit.ts";
import { buildTools } from "../infer/build.ts";
import { parseForms } from "../parse/forms.ts";
import { parseHar } from "../parse/har.ts";
import { originOf } from "../parse/http.ts";
import { parseOpenApi } from "../parse/openapi.ts";
import { parsePlaywrightTrace } from "../parse/playwright.ts";
import type { CallSample, SpecOperation } from "../model/types.ts";

export interface GenerateOptions {
  origin: string;
  har?: readonly string[];
  trace?: readonly string[];
  openapi?: readonly string[];
  forms?: readonly string[];
  outDir: string;
  name: string;
}

export interface GenerateSummary {
  toolCount: number;
  files: string[];
  notes: string[];
  toolNames: string[];
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read JSON ${file}: ${message}`);
  }
}

export async function generateFromInputs(options: GenerateOptions): Promise<GenerateSummary> {
  const owner = originOf(options.origin);
  const operations: SpecOperation[] = [];
  const calls: CallSample[] = [];
  const notes: string[] = [];
  const sources: string[] = [];
  let dropped = 0;

  for (const file of options.openapi ?? []) {
    sources.push(file);
    const parsed = parseOpenApi(await readJson(file), owner);
    operations.push(...parsed.operations);
    notes.push(...parsed.notes);
  }
  for (const file of options.forms ?? []) {
    sources.push(file);
    const parsed = parseForms(await readFile(file, "utf8"), owner);
    operations.push(...parsed.operations);
    notes.push(...parsed.notes);
  }
  for (const file of options.har ?? []) {
    sources.push(file);
    const parsed = parseHar(await readJson(file), owner);
    calls.push(...parsed.calls);
    dropped += parsed.dropped;
    if (parsed.ignoredNonHttp > 0) notes.push(`${file}: ignored ${parsed.ignoredNonHttp} non-http request(s).`);
  }
  for (const file of options.trace ?? []) {
    sources.push(file);
    const parsed = parsePlaywrightTrace(await readFile(file), owner);
    calls.push(...parsed.calls);
    dropped += parsed.dropped;
    if (parsed.calls.length === 0) {
      notes.push(`${file}: no same-origin requests were found. Archive entries: ${parsed.files.join(", ") || "none"}.`);
    }
  }

  if (operations.length === 0 && calls.length === 0) {
    throw new Error("Provide at least one HAR, Playwright trace, OpenAPI document, or HTML form file.");
  }

  const built = buildTools(operations, calls, notes);
  if (built.tools.length === 0) {
    throw new Error("No tools could be generated. Recorded traffic may have been static files or another origin.");
  }
  const rendered = renderProject({
    name: options.name,
    origin: owner.origin,
    sources,
    notes: built.notes,
    tools: built.tools,
    dropped,
    skippedStatic: built.skippedStatic,
  });
  await mkdir(options.outDir, { recursive: true });
  const files = Object.keys(rendered);
  for (const file of files) {
    await writeFile(path.join(options.outDir, file), rendered[file as keyof typeof rendered]);
  }
  return {
    toolCount: built.tools.length,
    files: files.map((file) => path.join(options.outDir, file)),
    notes: built.notes,
    toolNames: built.tools.map((tool) => tool.name),
  };
}
