import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

export const PRODUCTS = [
  { sku: "coffee", name: "Cedar coffee", detail: "Whole bean, 12 oz bag", priceCents: 1400 },
  { sku: "tea", name: "Smoked tea", detail: "Lapsang, 20 bags", priceCents: 900 },
  { sku: "honey", name: "Clover honey", detail: "8 oz jar", priceCents: 1100 },
] as const;

const ERRORS = new Set([
  "The basket is empty.",
  "Unknown item.",
  "Quantity must be a whole number from 1 to 12.",
]);

export function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character] ?? character;
  });
}

interface Line {
  sku: string;
  name: string;
  qty: number;
  priceCents: number;
}

interface Order {
  id: string;
  items: Line[];
  totalCents: number;
}

function createStore() {
  const quantities = new Map<string, number>();
  const orders: Order[] = [];
  let next = 1;

  function lines(): Line[] {
    const result: Line[] = [];
    for (const product of PRODUCTS) {
      const qty = quantities.get(product.sku);
      if (!qty) continue;
      result.push({ sku: product.sku, name: product.name, qty, priceCents: product.priceCents });
    }
    return result;
  }

  function total(items: Line[]): number {
    return items.reduce((sum, item) => sum + item.qty * item.priceCents, 0);
  }

  return {
    lines,
    orders: () => orders,
    add(sku: string, qty: number) {
      quantities.set(sku, (quantities.get(sku) ?? 0) + qty);
    },
    checkout(): Order | undefined {
      const items = lines();
      if (items.length === 0) return undefined;
      const order: Order = { id: `ord_${next}`, items, totalCents: total(items) };
      next += 1;
      quantities.clear();
      orders.push(order);
      return order;
    },
    cartBody() {
      const items = lines();
      return {
        items: items.map((item) => ({
          sku: item.sku,
          name: item.name,
          qty: item.qty,
          priceCents: item.priceCents,
          lineCents: item.qty * item.priceCents,
        })),
        totalCents: total(items),
      };
    },
  };
}

function product(sku: string) {
  return PRODUCTS.find((item) => item.sku === sku);
}

function parseQty(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  if (!Number.isInteger(number) || number < 1 || number > 12) return undefined;
  return number;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 100_000) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function fields(request: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(request);
  const type = request.headers["content-type"] ?? "";
  if (!raw) return {};
  if (type.includes("application/json")) {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  }
  const params = new URLSearchParams(raw);
  return Object.fromEntries(params);
}

function wantsHtml(request: IncomingMessage): boolean {
  const type = request.headers["content-type"] ?? "";
  if (type.includes("application/json")) return false;
  const accept = request.headers.accept ?? "";
  if (accept.includes("application/json") && !accept.includes("text/html")) return false;
  return true;
}

function securityHeaders(contentType: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    "content-type": contentType,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy":
      "default-src 'self'; style-src 'self'; script-src 'self'; form-action 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'",
    ...extra,
  };
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, securityHeaders("application/json; charset=utf-8"));
  response.end(JSON.stringify(body));
}

function sendHtml(response: ServerResponse, html: string): void {
  response.writeHead(200, securityHeaders("text/html; charset=utf-8"));
  response.end(html);
}

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(303, securityHeaders("text/plain; charset=utf-8", { location }));
  response.end();
}

function renderBasket(items: ReturnType<ReturnType<typeof createStore>["cartBody"]>["items"], totalCents: number): string {
  if (items.length === 0) {
    return `<p class="empty">Your basket is empty. Add a jar or a bag before checkout.</p>`;
  }
  const rows = items
    .map(
      (item) =>
        `<li>${escapeHtml(item.name)} — ${item.qty} at ${money(item.priceCents)}, line ${money(item.lineCents)}</li>`,
    )
    .join("");
  return `<ul class="lines">${rows}</ul><p class="total">Total <strong>${money(totalCents)}</strong></p>`;
}

function renderOrders(orders: Order[]): string {
  if (orders.length === 0) return `<p class="empty">No orders yet this session.</p>`;
  const rows = orders
    .map((order) => {
      const items = order.items.map((item) => `${escapeHtml(item.name)} × ${item.qty}`).join(", ");
      return `<li>${escapeHtml(order.id)} — ${money(order.totalCents)} — ${items}</li>`;
    })
    .join("");
  return `<ul class="lines">${rows}</ul>`;
}

function renderNotices(url: URL): string {
  const notices: string[] = [];
  const added = url.searchParams.get("added");
  const addedProduct = added ? product(added) : undefined;
  if (addedProduct) {
    notices.push(`<p class="notice" role="status">Added ${escapeHtml(addedProduct.name)} to the basket.</p>`);
  }
  const ordered = url.searchParams.get("ordered");
  if (ordered && /^ord_\d+$/.test(ordered)) {
    notices.push(`<p class="notice" role="status">Placed order ${escapeHtml(ordered)}.</p>`);
  }
  const error = url.searchParams.get("error");
  if (error && ERRORS.has(error)) {
    notices.push(`<p class="notice error" role="alert">${escapeHtml(error)}</p>`);
  } else if (error) {
    notices.push(`<p class="notice error" role="alert">That request was not accepted.</p>`);
  }
  return notices.join("");
}

async function page(url: URL, store: ReturnType<typeof createStore>): Promise<string> {
  const template = await readFile(path.join(root, "shop.html"), "utf8");
  const cart = store.cartBody();
  return template
    .replace("<!--@@NOTICES@@-->", renderNotices(url))
    .replace("<!--@@BASKET@@-->", renderBasket(cart.items, cart.totalCents))
    .replace("<!--@@ORDERS@@-->", renderOrders(store.orders()));
}

export async function startPantry(port = 0): Promise<{ url: string; close: () => Promise<void> }> {
  const store = createStore();
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const method = request.method ?? "GET";
      if (method === "GET" && url.pathname === "/") {
        sendHtml(response, await page(url, store));
        return;
      }
      if (method === "GET" && url.pathname === "/shop.css") {
        response.writeHead(200, securityHeaders("text/css; charset=utf-8"));
        response.end(await readFile(path.join(root, "shop.css")));
        return;
      }
      if (method === "GET" && url.pathname === "/llms.txt") {
        response.writeHead(200, securityHeaders("text/plain; charset=utf-8"));
        response.end(await readFile(path.join(root, "llms.txt")));
        return;
      }
      if (method === "GET" && url.pathname === "/openapi.json") {
        response.writeHead(200, securityHeaders("application/json; charset=utf-8"));
        response.end(await readFile(path.join(root, "openapi.json")));
        return;
      }
      if (method === "GET" && url.pathname === "/generated/browser.js") {
        try {
          const script = await readFile(path.join(root, "generated", "browser.js"));
          response.writeHead(200, securityHeaders("text/javascript; charset=utf-8"));
          response.end(script);
        } catch {
          response.writeHead(404, securityHeaders("text/plain; charset=utf-8"));
          response.end("Generated browser.js is not on disk yet. Run npm run generate:demo.");
        }
        return;
      }
      if (method === "GET" && url.pathname === "/favicon.ico") {
        response.writeHead(204, securityHeaders("text/plain; charset=utf-8"));
        response.end();
        return;
      }
      if (method === "GET" && url.pathname === "/api/products") {
        sendJson(response, 200, { products: PRODUCTS });
        return;
      }
      if (method === "GET" && url.pathname === "/api/cart") {
        sendJson(response, 200, store.cartBody());
        return;
      }
      if (method === "GET" && url.pathname === "/api/orders") {
        sendJson(response, 200, { orders: store.orders() });
        return;
      }
      if (method === "POST" && url.pathname === "/api/cart") {
        const body = await fields(request);
        const item = typeof body.sku === "string" ? product(body.sku) : undefined;
        const qty = parseQty(body.qty);
        const html = wantsHtml(request);
        if (!item) {
          if (html) redirect(response, "/?error=Unknown+item.");
          else sendJson(response, 400, { error: "Unknown item." });
          return;
        }
        if (qty === undefined) {
          if (html) redirect(response, "/?error=Quantity+must+be+a+whole+number+from+1+to+12.");
          else sendJson(response, 400, { error: "Quantity must be a whole number from 1 to 12." });
          return;
        }
        store.add(item.sku, qty);
        if (html) redirect(response, `/?added=${encodeURIComponent(item.sku)}`);
        else sendJson(response, 200, store.cartBody());
        return;
      }
      if (method === "POST" && url.pathname === "/api/checkout") {
        await readBody(request);
        const order = store.checkout();
        const html = wantsHtml(request);
        if (!order) {
          if (html) redirect(response, "/?error=The+basket+is+empty.");
          else sendJson(response, 400, { error: "The basket is empty." });
          return;
        }
        if (html) redirect(response, `/?ordered=${encodeURIComponent(order.id)}`);
        else sendJson(response, 200, { order });
        return;
      }
      response.writeHead(404, securityHeaders("text/plain; charset=utf-8"));
      response.end("Not found");
    } catch {
      if (!response.headersSent) sendJson(response, 400, { error: "The request could not be read." });
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Pantry did not bind a port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const port = Number(process.env.PORT ?? 44731);
  const pantry = await startPantry(port);
  process.stdout.write(`North Pantry is at ${pantry.url}\n`);
}
