import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import { generateFromInputs } from "../src/generate/run.ts";
import { startPantry } from "../demo/server.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function generateFixture(outDir: string) {
  return generateFromInputs({
    origin: "http://127.0.0.1:44731",
    outDir,
    name: "pantry",
    har: ["test/fixtures/pantry.har"],
    openapi: ["demo/openapi.json"],
    forms: ["demo/shop.html"],
  });
}

test("committed demo output matches a fresh generation", async () => {
  const dir = path.join(root, "demo/.e2e-out/committed");
  await generateFixture(dir);
  for (const file of ["tools.ts", "tools.test.ts", "browser.js", "REVIEW.md", "manifest.json"]) {
    assert.equal(
      await readFile(path.join(dir, file), "utf8"),
      await readFile(path.join(root, "demo/generated", file), "utf8"),
      file,
    );
  }
});

test("the CLI writes tools that call the pantry and refuse unconfirmed writes", async () => {
  const outDir = await mkdtemp(path.join(tmpdir(), "ownmcp-"));
  const inside = path.join(root, "demo/.e2e-out/fixture");
  const summary = await generateFixture(inside);
  assert.deepEqual(summary.toolNames, ["add_to_cart", "get_cart", "list_orders", "list_products", "place_order"]);
  const browser = await readFile(path.join(inside, "browser.js"), "utf8");
  const checked = spawn(process.execPath, ["--check", path.join(inside, "browser.js")]);
  const checkCode = await new Promise<number>((resolve) => {
    checked.on("close", (code) => resolve(code ?? 1));
  });
  assert.equal(checkCode, 0);
  assert.equal(browser.includes("https://cdn.example"), false);
  assert.match(browser, /document\.modelContext/);

  const pantry = await startPantry();
  try {
    const toolsModule = await import(pathToFileURL(path.join(inside, "tools.ts")).href) as {
      createPantryTools: (options: { baseUrl: string; confirm?: (request: { name: string }) => boolean | Promise<boolean> }) => Array<{
        name: string;
        annotations?: { readOnlyHint?: boolean; consequentialHint?: boolean };
        execute: (input: Record<string, unknown>, agent?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; body: unknown }>;
      }>;
    };
    const denied = toolsModule.createPantryTools({ baseUrl: pantry.url, confirm: async () => false });
    const add = denied.find((tool) => tool.name === "add_to_cart");
    assert.equal(add?.annotations?.consequentialHint, true);
    await assert.rejects(async () => {
      if (!add) throw new Error("missing add_to_cart");
      await add.execute({ sku: "coffee", qty: 1 }, {});
    }, /confirmation/i);
    const cart = (await fetch(`${pantry.url}/api/cart`).then((response) => response.json())) as { items: unknown[] };
    assert.equal(cart.items.length, 0);

    const allowed = toolsModule.createPantryTools({ baseUrl: pantry.url, confirm: async () => true });
    const list = allowed.find((tool) => tool.name === "list_products");
    assert.equal(list?.annotations?.readOnlyHint, true);
    const products = await list?.execute({}, {});
    assert.equal(products?.ok, true);
    const added = await allowed.find((tool) => tool.name === "add_to_cart")?.execute({ sku: "honey", qty: 2 }, {});
    assert.equal(added?.ok, true);
    const after = (await fetch(`${pantry.url}/api/cart`).then((response) => response.json())) as {
      items: Array<{ sku: string; qty: number }>;
    };
    assert.deepEqual(after.items.map((item) => [item.sku, item.qty]), [["honey", 2]]);
    const order = await allowed.find((tool) => tool.name === "place_order")?.execute({}, {});
    assert.equal(order?.ok, true);
    const orders = (await fetch(`${pantry.url}/api/orders`).then((response) => response.json())) as {
      orders: Array<{ id: string }>;
    };
    assert.equal(orders.orders.length, 1);

    const child = spawn(process.execPath, ["--test", path.join(inside, "tools.test.ts")], {
      cwd: root,
      env: { ...process.env, OWNMCP_BASE_URL: pantry.url },
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    const code = await new Promise<number>((resolve) => {
      child.on("close", (status) => resolve(status ?? 1));
    });
    assert.equal(code, 0, output);
  } finally {
    await pantry.close();
  }
  assert.equal(outDir.length > 0, true);
});

test("generated browser script enforces confirmation before fetch", async () => {
  const inside = path.join(root, "demo/.e2e-out/browser");
  await generateFixture(inside);
  const source = await readFile(path.join(inside, "browser.js"), "utf8");
  const fetches: string[] = [];
  const sandbox = {
    __OWNMCP_NO_AUTORUN: true,
    URL,
    URLSearchParams,
    fetch: async (url: URL) => {
      fetches.push(String(url));
      return { ok: true, status: 200, async text() { return JSON.stringify({ items: [] }); } };
    },
    document: { getElementById: () => null, createElement: () => ({}) },
    location: { origin: "http://127.0.0.1:9" },
    window: { confirm: () => false },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  const tools = (await vm.runInContext(
    "registerGeneratedTools({ baseUrl: 'http://127.0.0.1:9', confirm: async () => false })",
    sandbox,
  )) as Array<{ name: string; execute: (input: Record<string, unknown>, agent?: object) => Promise<unknown> }>;
  const add = tools.find((tool) => tool.name === "add_to_cart");
  await assert.rejects(async () => {
    if (!add) throw new Error("missing add_to_cart");
    await add.execute({ sku: "coffee", qty: 1 }, {});
  }, /confirmation/i);
  assert.deepEqual(fetches, []);
  await vm.runInContext("registerGeneratedTools({ baseUrl: 'http://127.0.0.1:9', confirm: async () => true })", sandbox);
  const allowed = (await vm.runInContext(
    "createPantryTools({ baseUrl: 'http://127.0.0.1:9', confirm: async () => true }).find((tool) => tool.name === 'list_products').execute({}, {})",
    sandbox,
  )) as { ok: boolean };
  assert.equal(allowed.ok, true);
  assert.equal(fetches.length, 1);
});
