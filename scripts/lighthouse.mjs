import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";

const port = 44741;
const server = spawn(process.execPath, ["demo/server.ts"], {
  env: { ...process.env, PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (chunk) => {
  serverLog += chunk.toString();
});
server.stderr.on("data", (chunk) => {
  serverLog += chunk.toString();
});

function finish(code) {
  server.kill();
  process.exit(code);
}

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Pantry did not start\n${serverLog}`)), 10000);
  server.stdout.on("data", () => {
    if (serverLog.includes("North Pantry")) {
      clearTimeout(timer);
      resolve();
    }
  });
});

const chromeFlags = "--headless=new --no-sandbox --disable-gpu --enable-features=WebMCP,DeclarativeWebMCP";
const outputPath = "docs/lighthouse-full.json";
const child = spawn(
  "npx",
  [
    "lighthouse",
    `http://127.0.0.1:${port}/`,
    "--only-categories=agentic-browsing",
    "--output=json",
    `--output-path=${outputPath}`,
    `--chrome-flags=${chromeFlags}`,
    "--quiet",
    "--preset=desktop",
  ],
  { stdio: ["ignore", "inherit", "inherit"] },
);
const code = await new Promise((resolve) => {
  child.on("close", (status) => resolve(status ?? 1));
});
if (code !== 0) {
  console.error(`lighthouse exited ${code}`);
  finish(code);
}

const report = JSON.parse(await (await import("node:fs/promises")).readFile(outputPath, "utf8"));
const category = report.categories?.["agentic-browsing"];
function toolNames(node, found = []) {
  if (!node || typeof node !== "object") return found;
  if (typeof node.tool === "string") found.push(node.tool);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((item) => toolNames(item, found));
    else if (value && typeof value === "object") toolNames(value, found);
  }
  return found;
}
const summary = {
  lighthouseVersion: report.lighthouseVersion,
  requestedUrl: report.requestedUrl,
  fetchTime: report.fetchTime,
  chromeFlags,
  category: category
    ? {
        title: category.title,
        score: category.score,
      }
    : null,
  audits: Object.fromEntries(
    (category?.auditRefs ?? []).map((ref) => {
      const audit = report.audits[ref.id] ?? {};
      return [
        ref.id,
        {
          title: audit.title,
          score: audit.score,
          scoreDisplayMode: audit.scoreDisplayMode,
          displayValue: audit.displayValue ?? null,
          tools: toolNames(audit.details),
          warnings: audit.warnings ?? [],
          errorMessage: audit.errorMessage ?? null,
        },
      ];
    }),
  ),
};
await writeFile("docs/lighthouse-agentic.json", `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
finish(0);
