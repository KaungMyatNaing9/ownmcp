import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { generateFromInputs } from "../src/generate/run.ts";
import { startPantry } from "../demo/server.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("a recorded pantry session generates tools that place an order", { timeout: 60_000 }, async () => {
  const pantry = await startPantry();
  const outDir = await mkdtemp(path.join(tmpdir(), "ownmcp-trace-"));
  const harPath = path.join(outDir, "session.har");
  const tracePath = path.join(outDir, "session.zip");
  const browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const context = await browser.newContext({
      recordHar: { path: harPath, content: "embed" },
    });
    await context.tracing.start({ screenshots: false, snapshots: false, sources: false });
    const page = await context.newPage();
    await page.goto(pantry.url);
    await page.evaluate(async () => {
      await fetch("/api/products");
      await fetch("/api/cart");
      await fetch("/api/orders");
    });
    await page.selectOption("#sku", "tea");
    await page.locator("#qty").fill("2");
    await Promise.all([
      page.waitForURL(/added=tea/),
      page.getByRole("button", { name: "Add to basket" }).click(),
    ]);
    await page.getByText("Smoked tea — 2 at $9.00").waitFor();
    await Promise.all([
      page.waitForURL(/ordered=ord_/),
      page.getByRole("button", { name: "Place order" }).click(),
    ]);
    await page.getByText(/Placed order ord_/).waitFor();
    await page.screenshot({ path: "/tmp/pantry-order.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: "/tmp/pantry-mobile.png", fullPage: true });
    await context.tracing.stop({ path: tracePath });
    await context.close();
    await browser.close();

    const generated = path.join(root, "demo/.e2e-out/recorded");
    const summary = await generateFromInputs({
      origin: pantry.url,
      outDir: generated,
      name: "pantry",
      har: [harPath],
      trace: [tracePath],
      openapi: ["demo/openapi.json"],
      forms: ["demo/shop.html"],
    });
    assert.equal(summary.toolNames.includes("add_to_cart"), true);
    assert.equal(summary.toolNames.includes("place_order"), true);
    assert.equal(summary.toolNames.includes("list_products"), true);
    const manifest = await import("node:fs/promises").then((fs) => fs.readFile(path.join(generated, "manifest.json"), "utf8"));
    assert.equal(manifest.includes("cdn.example"), false);
    assert.match(manifest, /playwright|har/);

    const fresh = await startPantry();
    try {
      const tools = await import(pathToFileURL(path.join(generated, "tools.ts")).href) as {
        createPantryTools: (options: { baseUrl: string; confirm?: () => boolean | Promise<boolean> }) => Array<{
          name: string;
          execute: (input: Record<string, unknown>, agent?: object) => Promise<{ ok: boolean; body: { order?: { id: string }; items?: unknown[] } }>;
        }>;
      };
      const denied = tools.createPantryTools({ baseUrl: fresh.url, confirm: async () => false });
      const deniedAdd = denied.find((tool) => tool.name === "add_to_cart");
      await assert.rejects(async () => {
        if (!deniedAdd) throw new Error("missing add_to_cart");
        await deniedAdd.execute({ sku: "coffee", qty: 1 }, {});
      }, /confirmation/i);
      const quiet = (await fetch(`${fresh.url}/api/cart`).then((response) => response.json())) as { items: unknown[] };
      assert.equal(quiet.items.length, 0);
      const live = tools.createPantryTools({ baseUrl: fresh.url, confirm: async () => true });
      const added = await live.find((tool) => tool.name === "add_to_cart")?.execute({ sku: "tea", qty: 2 }, {});
      assert.equal(added?.ok, true);
      const ordered = await live.find((tool) => tool.name === "place_order")?.execute({}, {});
      assert.equal(ordered?.ok, true);
      assert.match(JSON.stringify(ordered?.body), /ord_/);
    } finally {
      await fresh.close();
    }
  } finally {
    await browser.close().catch(() => undefined);
    await pantry.close();
  }
});
