import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryModelContext } from "ownmcp";
import { createPantryTools, registerPantryTools } from "./tools.ts";

const baseUrl = process.env.OWNMCP_BASE_URL ?? "";
const samples = {
  "add_to_cart": {
    "sku": "coffee",
    "qty": 1
  },
  "get_cart": {},
  "list_orders": {},
  "list_products": {},
  "place_order": {}
} as const;

test("read and state-changing tools are labeled", () => {
  const tools = createPantryTools({ baseUrl: "http://127.0.0.1:9", confirm: async () => false });
  for (const tool of tools) {
    assert.equal(tool.annotations?.debugging, false);
    assert.equal(tool.annotations?.untrustedContentHint, false);
    if (["add_to_cart","place_order"].includes(tool.name)) {
      assert.equal(tool.annotations?.readOnlyHint, false);
      assert.equal(tool.annotations?.consequentialHint, true);
    } else {
      assert.equal(tool.annotations?.readOnlyHint, true);
      assert.equal(tool.annotations?.consequentialHint, false);
    }
  }
});

test("state-changing tools refuse to run without confirmation", async () => {
  const tools = createPantryTools({ baseUrl: "http://127.0.0.1:9", confirm: async () => false });
  for (const name of ["add_to_cart","place_order"]) {
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
  await registerPantryTools({ baseUrl, confirm: async () => true, context });
  const registered = await context.getTools();
  for (const name of ["get_cart","list_orders","list_products","add_to_cart","place_order"]) {
    const tool = registered.find((item) => item.name === name);
    assert.ok(tool, name);
    const raw = await context.executeTool(tool, { ...samples[name as keyof typeof samples] });
    const result = JSON.parse(raw) as { ok?: boolean; status?: number; body?: unknown };
    assert.equal(result.ok, true, name + " " + JSON.stringify(result));
  }
});
