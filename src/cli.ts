#!/usr/bin/env node
import { generateFromInputs } from "./generate/run.ts";

function collect(argv: readonly string[]): { command: string; flags: Map<string, string[]> } {
  const flags = new Map<string, string[]>();
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "--") continue;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      flags.set(key, ["true"]);
      continue;
    }
    const values = flags.get(key) ?? [];
    values.push(next);
    flags.set(key, values);
    index += 1;
  }
  return { command: positionals[0] ?? "", flags };
}

function help(): string {
  return `ownmcp generate — WebMCP registerTool code for an app you own

Usage:
  ownmcp generate --origin http://127.0.0.1:44731 --out demo/generated --name pantry \\
    --openapi demo/openapi.json --forms demo/shop.html --har recording.har --trace trace.zip

The origin is the app you are generating tools for. Requests to any other origin
are dropped. This does not fetch or crawl that origin; it only reads local files.

--name     Identifier used in create<Name>Tools. Letters and digits, starting with a letter.
--out      Directory for tools.ts, tools.test.ts, browser.js, REVIEW.md, and manifest.json.
--har      HAR file. Repeat for more than one.
--trace    Playwright trace zip. Repeat for more than one.
--openapi  OpenAPI 3 JSON. Repeat for more than one.
--forms    HTML file with forms. Repeat for more than one.
`;
}

async function main(): Promise<void> {
  const { command, flags } = collect(process.argv.slice(2));
  if (flags.has("help") || command === "" || command === "help") {
    process.stdout.write(help());
    return;
  }
  if (command !== "generate") {
    process.stderr.write(`Unknown command ${command}\n\n${help()}`);
    process.exitCode = 1;
    return;
  }
  const origin = flags.get("origin")?.[0];
  const outDir = flags.get("out")?.[0];
  const name = flags.get("name")?.[0] ?? "app";
  if (!origin || !outDir) {
    process.stderr.write(`--origin and --out are required\n\n${help()}`);
    process.exitCode = 1;
    return;
  }
  try {
    const summary = await generateFromInputs({
      origin,
      outDir,
      name,
      har: flags.get("har"),
      trace: flags.get("trace"),
      openapi: flags.get("openapi"),
      forms: flags.get("forms"),
    });
    process.stdout.write(
      `Wrote ${summary.toolCount} tool(s): ${summary.toolNames.join(", ")}\n${summary.files.map((file) => `  ${file}`).join("\n")}\n`,
    );
    for (const note of summary.notes) process.stdout.write(`note: ${note}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

await main();
