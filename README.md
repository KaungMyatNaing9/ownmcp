# ownmcp

`ownmcp` generates reviewed [WebMCP](https://webmachinelearning.github.io/webmcp/) `registerTool` code for a web app you own. You give it a HAR, a Playwright trace, an OpenAPI 3 JSON file, and/or the app's HTML forms, plus the origin those inputs belong to. It writes a TypeScript module, a browser script, a review note, and a node:test file.

It does not crawl sites, and it drops any recorded request whose origin is not the one you declared. The package is a private draft: `package.json` sets `"private": true`, and nothing here has been published to npm.

The name `ownmcp` was unused on the npm registry when checked on 13 November 2026 (`npm view ownmcp` returned no package).

## Run

Node.js 22.18 or newer.

```bash
npm install
npm test
npm run demo
```

The demo listens on [http://127.0.0.1:44731](http://127.0.0.1:44731). Override the port with `PORT`.

Regenerate the committed North Pantry tools:

```bash
npm run generate:demo
```

Point the CLI at your own recordings:

```bash
node src/cli.ts generate \
  --origin http://127.0.0.1:44731 \
  --name pantry \
  --out demo/generated \
  --openapi demo/openapi.json \
  --forms demo/shop.html \
  --har test/fixtures/pantry.har
```

`--trace recording.zip` accepts a Playwright trace. Repeat `--har`, `--trace`, `--openapi`, and `--forms` to pass more than one file. At least one input is required.

Generated handlers call `options.baseUrl`, not a host baked in from the recording. Pass your running app:

```bash
OWNMCP_BASE_URL=http://127.0.0.1:44731 node --test demo/generated/tools.test.ts
```

Without `OWNMCP_BASE_URL`, the live-call test is skipped. The confirmation test still runs.

## What you get

| File | Role |
| --- | --- |
| `tools.ts` | `createPantryTools` and `registerPantryTools`. This is the file to review. |
| `tools.test.ts` | Checks read vs state-changing labels, refuses unconfirmed writes, and calls a running app when `OWNMCP_BASE_URL` is set. |
| `browser.js` | Registers the same tools on `document.modelContext` in the page. State-changing tools call `window.confirm` first. |
| `REVIEW.md` | Effect, confirmation, sources, and review notes for each tool. |
| `manifest.json` | The same facts as data. |

Read tools set `readOnlyHint: true`. State-changing tools set `consequentialHint: true` and call `requireConfirmation()` before `fetch`. `confirm()` has to return `true`. That gate is ownmcp's. The WebMCP draft's `consequentialHint` only asks a client to prompt; it does not give the page a way to require the prompt. See [docs/research.md](docs/research.md).

`document.modelContext` is named in one library module, `src/api/surface.ts`. Generated browser code gets that expression from the same module. A spec move should be a small edit there, plus the emitter that prints it.

## North Pantry

The demo is a one-page shop: cedar coffee, smoked tea, and clover honey. The basket and orders live in the server process. Checkout records an order and does not charge a card.

`npm test` records a Playwright session against that server (system Chrome), generates tools from the trace, the HAR, `demo/openapi.json`, and `demo/shop.html`, then calls the generated handlers. An unconfirmed `add_to_cart` leaves the basket empty. A confirmed add and `place_order` create an order.

The page also puts `toolname` and `tooldescription` on its two forms. Chrome treats those as declarative tools. The generated script registers the read tools and, if a form already registered the same name, leaves that registration in place. Chrome 157 rejects a duplicate with `InvalidStateError`.

## Tests

`npm test` is the check that was run for this draft. On 13 November 2026 it reported 14 passing tests and 0 failures. One of those tests spawns `demo/generated/tools.test.ts`, which itself contains 3 tests (labels, the confirmation refusal, and live calls against the demo). Those 3 are not in the 14; they passed as a child process. `npm run typecheck` runs `tsc --noEmit`, including `demo/generated`.

What that covers:

- HAR entries for any other origin are dropped and do not appear in generated source.
- An OpenAPI file whose servers are a non-loopback host other than `--origin` is refused. A different loopback port is kept, with a review note.
- HTML forms become tools. A form that posts to another host is skipped.
- A Playwright trace zip is read, including deflate. ZIP64 archives are not supported.
- Read tools do not require confirmation. State-changing tools throw `ConfirmationRequiredError` until `confirm()` returns true, and they do not call `fetch` before that.
- Against the live demo: list the shelf, add honey, and place an order. A refused add does not change the basket.
- The in-memory `createMemoryModelContext()` registers, rejects duplicate names, unregisters on abort, sorts `getTools()`, and serializes results the way Chrome 157 did in a headless probe (objects as JSON text, strings unchanged).
- Only `src/api/surface.ts` contains the source text `document.modelContext`.

What that does not cover is listed under Limitations.

## Lighthouse

`npm run lighthouse` starts the demo and runs Lighthouse 13.6.0 with `--only-categories=agentic-browsing`. The run recorded in [docs/lighthouse-agentic.json](docs/lighthouse-agentic.json) used Chrome flags `--headless=new --no-sandbox --disable-gpu --enable-features=WebMCP,DeclarativeWebMCP`.

On 13 November 2026, against `http://127.0.0.1:44741/`, Lighthouse 13.6.0 returned category score `1` and these audits:

| Audit | Result |
| --- | --- |
| Accessibility tree is well-formed | score 1, binary |
| WebMCP form coverage | score 1, binary |
| WebMCP tools registered | score 1, informative. Tools seen: `get_cart`, `list_orders`, `list_products`, `add_to_cart`, `place_order` |
| WebMCP schemas are valid | score 1, binary |
| Cumulative Layout Shift | score 1, display value 0.027 |
| llms.txt follows recommendations | score 1, binary |
| ARD manifest is valid | score null, not applicable |

Chrome's own scoring doc says this category is informational and not a 0–100 benchmark. The CLI still returned a category score of 1 for this run. The ARD audit is not applicable because the demo does not publish an ARD manifest. `--enable-webmcp-testing` alone did not expose `document.modelContext` in headless Chrome 157.0.8103.50; the feature flag above did. Details are in [docs/research.md](docs/research.md).

## Limitations

- WebMCP is a Draft Community Group Report, not a W3C Standard, and Chrome ships it as an origin trial. This repo does not enroll an origin.
- No browser agent was asked to complete a task. Tests call `execute` directly, or call `executeTool` on the in-memory double.
- Chrome's `executeTool` rejects a thrown page error as `OperationError` and does not pass the original message across documents. The test double keeps `ConfirmationRequiredError` so the suite can see the gate. That difference is intentional and untested against Chrome's wrapping.
- `consequentialHint` is set on every mutation. The spec's examples are significant or hard to undo actions, such as booking or paying. Clear the hint on a reversible action when you review the file. The `confirm()` gate still applies until you remove that call.
- `untrustedContentHint` is left false. Set it if a tool returns content the site does not control.
- OpenAPI input is JSON only, version 3. YAML and OpenAPI 2 are refused.
- Forms are parsed from HTML text. Client-rendered forms are invisible to the generator.
- Path ids are inferred only for all-digit segments, UUIDs, and long hex. Other dynamic segments stay literal unless OpenAPI templates them.
- The generator does not emit `outputSchema`.
- Playwright traces must be ordinary ZIP files. Screenshots and snapshots are unnecessary; the parser reads `.network`, `.trace`, and `.har` entries.
- `createMemoryModelContext()` does not simulate permissions policy, cross-origin `exposedTo` / `fromOrigins`, or `toolchange` events.
- The demo checkout does not take payment, and its memory resets when the process exits.

## Layout

```
src/api/surface.ts        WebMCP types, registration, and the test double
src/parse/                HAR, Playwright trace, OpenAPI, HTML forms
src/infer/build.ts        Merge those into tools and label read vs mutation
src/generate/             Write the reviewed files
src/cli.ts                `ownmcp generate`
demo/                     North Pantry
demo/generated/           Output checked in for the fixture
docs/research.md          What was checked in the spec and in Chrome 157
```
