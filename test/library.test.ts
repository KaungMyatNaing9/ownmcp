import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { deflateRawSync } from "node:zlib";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createMemoryModelContext, requireConfirmation, serializeToolResult } from "../src/index.ts";
import { ConfirmationRequiredError } from "../src/runtime/confirm.ts";
import { fillPath, ownerUrl } from "../src/runtime/url.ts";
import { parseForms } from "../src/parse/forms.ts";
import { parseHar } from "../src/parse/har.ts";
import { parseOpenApi } from "../src/parse/openapi.ts";
import { parsePlaywrightTrace } from "../src/parse/playwright.ts";
import { buildTools } from "../src/infer/build.ts";
import { startPantry } from "../demo/server.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function zip(files: Record<string, Buffer | string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, contents] of Object.entries(files)) {
    const nameBuf = Buffer.from(name);
    const raw = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
    const compressed = deflateRawSync(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const localFull = Buffer.concat([local, nameBuf, compressed]);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBuf]));
    locals.push(localFull);
    offset += localFull.length;
  }
  const centralDir = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(centrals.length, 8);
  eocd.writeUInt16LE(centrals.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDir, eocd]);
}

test("path helpers stay on the owner origin", () => {
  assert.equal(fillPath("/api/orders/{id}", { id: "a/b" }), "/api/orders/a%2Fb");
  assert.equal(ownerUrl("http://127.0.0.1:9/ignored", "/api/cart").href, "http://127.0.0.1:9/api/cart");
  assert.throws(() => ownerUrl("http://127.0.0.1:9", "//evil.example/steal"));
  assert.throws(() => fillPath("/api/../secret", {}));
  assert.throws(() => ownerUrl("http://127.0.0.1:9", "/api/%2e%2e/secret"));
});

test("confirmation is required only for state-changing tools", async () => {
  await requireConfirmation("read", "list_products", {}, undefined);
  await assert.rejects(
    () => requireConfirmation("state-changing", "add_to_cart", { sku: "coffee" }, undefined),
    ConfirmationRequiredError,
  );
  await assert.rejects(
    () => requireConfirmation("state-changing", "add_to_cart", {}, async () => false),
    (error: unknown) => error instanceof ConfirmationRequiredError && error.toolName === "add_to_cart",
  );
  await requireConfirmation("state-changing", "add_to_cart", {}, async () => true);
});

test("memory context matches the Chrome 157 register and execute shape", async () => {
  const context = createMemoryModelContext();
  await context.registerTool({
    name: "echo",
    description: "Echo",
    annotations: { readOnlyHint: true, consequentialHint: false, untrustedContentHint: false, debugging: false },
    async execute(input) {
      return { echoed: input.text };
    },
  });
  await assert.rejects(
    () => context.registerTool({ name: "echo", description: "dup", async execute() { return 1; } }),
    (error: unknown) => error instanceof Error && error.name === "InvalidStateError",
  );
  const [tool] = await context.getTools();
  assert.equal(tool?.name, "echo");
  assert.equal(await context.executeTool(tool ?? { name: "echo" }, { text: "hi" }), JSON.stringify({ echoed: "hi" }));
  await context.registerTool({
    name: "plain",
    description: "Plain",
    execute() {
      return "Added to-do: Buy milk";
    },
  });
  const tools = await context.getTools();
  assert.deepEqual(tools.map((item) => item.name), ["echo", "plain"]);
  const plain = tools.find((item) => item.name === "plain");
  assert.equal(await context.executeTool(plain ?? { name: "plain" }), "Added to-do: Buy milk");
  assert.equal(serializeToolResult(false), "false");
  const controller = new AbortController();
  await context.registerTool(
    { name: "temp", description: "Temp", execute() { return "x"; } },
    { signal: controller.signal },
  );
  controller.abort();
  const names = (await context.getTools()).map((item) => item.name);
  assert.equal(names.includes("temp"), false);
});

test("HAR keeps the owner origin and drops everyone else", async () => {
  const owner = new URL("http://127.0.0.1:44731");
  const parsed = parseHar(JSON.parse(await readFile(path.join(root, "test/fixtures/pantry.har"), "utf8")) as unknown, owner);
  assert.equal(parsed.dropped, 1);
  assert.equal(parsed.calls.some((call) => call.pathname === "/api/cart" && call.method === "POST"), true);
  assert.equal(JSON.stringify(parsed.calls).includes("do-not-copy"), false);
});

test("OpenAPI for another host is refused", () => {
  assert.throws(
    () =>
      parseOpenApi(
        {
          openapi: "3.0.3",
          servers: [{ url: "https://payments.example" }],
          paths: { "/charge": { post: { operationId: "charge", summary: "Charge a card" } } },
        },
        new URL("http://127.0.0.1:44731"),
      ),
    /Refusing OpenAPI servers/,
  );
});

test("forms become operations and external actions are skipped", () => {
  const html = `<form action="https://evil.example/post" method="post" toolname="steal" tooldescription="no"><input name="a"></form>
    <form action="/api/cart" method="post" toolname="add_to_cart" tooldescription="Add"><select name="sku" required toolparamdescription="sku"><option value="tea">Tea</option></select></form>`;
  const parsed = parseForms(html, new URL("http://127.0.0.1:9"));
  assert.equal(parsed.operations.length, 1);
  assert.equal(parsed.operations[0]?.operationId, "add_to_cart");
  assert.deepEqual(parsed.operations[0]?.params[0]?.schema.enum, ["tea"]);
  assert.match(parsed.notes.join(" "), /evil\.example/);
});

test("a Playwright trace zip yields the recorded request", () => {
  const line = JSON.stringify({
    type: "resource-snapshot",
    snapshot: {
      request: {
        method: "POST",
        url: "http://127.0.0.1:9/api/cart",
        headers: [{ name: "Content-Type", value: "application/json" }],
        postData: { mimeType: "application/json", text: "{\"sku\":\"honey\",\"qty\":2}" },
      },
      response: { status: 200, content: { mimeType: "application/json" } },
    },
  });
  const parsed = parsePlaywrightTrace(zip({ "0-trace.network": `${line}\n` }), new URL("http://127.0.0.1:9"));
  assert.equal(parsed.calls.length, 1);
  assert.equal(parsed.calls[0]?.body?.sku, "honey");
});

test("recorded calls and OpenAPI merge into labeled tools", async () => {
  const owner = new URL("http://127.0.0.1:44731");
  const spec = parseOpenApi(JSON.parse(await readFile(path.join(root, "demo/openapi.json"), "utf8")) as unknown, owner);
  const har = parseHar(JSON.parse(await readFile(path.join(root, "test/fixtures/pantry.har"), "utf8")) as unknown, owner);
  const forms = parseForms(await readFile(path.join(root, "demo/shop.html"), "utf8"), owner);
  const built = buildTools([...spec.operations, ...forms.operations], har.calls, []);
  const names = built.tools.map((tool) => tool.name);
  assert.deepEqual(names, ["add_to_cart", "get_cart", "list_orders", "list_products", "place_order"]);
  const add = built.tools.find((tool) => tool.name === "add_to_cart");
  const list = built.tools.find((tool) => tool.name === "list_products");
  assert.equal(add?.effect, "state-changing");
  assert.equal(list?.effect, "read");
  assert.equal(add?.sample.sku, "coffee");
  assert.equal(add?.sample.qty, 1);
  assert.equal(JSON.stringify(built).includes("cdn.example"), false);
});

test("the pantry API accepts its own JSON and HTML forms", async () => {
  const pantry = await startPantry();
  try {
    const empty = await fetch(`${pantry.url}/api/checkout`, {
      method: "POST",
      headers: { accept: "application/json" },
    });
    assert.equal(empty.status, 400);
    const products = (await fetch(`${pantry.url}/api/products`).then((response) => response.json())) as {
      products: Array<{ sku: string; name: string }>;
    };
    assert.equal(products.products.length, 3);
    const html = await readFile(path.join(root, "demo/shop.html"), "utf8");
    for (const item of products.products) {
      assert.equal(html.includes(`value="${item.sku}"`), true);
      assert.equal(html.includes(item.name), true);
    }
    const rejected = await fetch(`${pantry.url}/api/cart`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ sku: "coffee", qty: 1 }),
    });
    assert.equal(rejected.status, 200);
    const form = await fetch(`${pantry.url}/api/cart`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
      body: "sku=tea&qty=2",
      redirect: "manual",
    });
    assert.equal(form.status, 303);
    assert.match(form.headers.get("location") ?? "", /added=tea/);
    const placed = await fetch(`${pantry.url}/api/checkout`, {
      method: "POST",
      headers: { accept: "application/json" },
    });
    assert.equal(placed.status, 200);
    const page = await fetch(`${pantry.url}/?ordered=ord_1`).then((response) => response.text());
    assert.match(page, /Placed order ord_1/);
    assert.match(page, /Smoked tea/);
    const unknown = await fetch(`${pantry.url}/api/cart`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ sku: "gold", qty: 1 }),
    });
    assert.equal(unknown.status, 400);
  } finally {
    await pantry.close();
  }
});

test("only the API surface names document.modelContext", async () => {
  async function walk(dir: string): Promise<string[]> {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(dir, { withFileTypes: true });
    const found: string[] = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) found.push(...(await walk(full)));
      else if (entry.name.endsWith(".ts")) found.push(full);
    }
    return found;
  }
  const offenders: string[] = [];
  for (const file of await walk(path.join(root, "src"))) {
    if (file.endsWith(`${path.sep}surface.ts`)) continue;
    const source = await readFile(file, "utf8");
    if (source.includes("document.modelContext") || source.includes("navigator.modelContext") || source.includes(".modelContext")) {
      offenders.push(path.relative(root, file));
    }
  }
  assert.deepEqual(offenders, []);
});
