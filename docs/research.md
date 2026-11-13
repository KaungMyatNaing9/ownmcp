# WebMCP research for ownmcp

Checked on 13 November 2026. This is the evidence behind the generator. It is not a claim that the API is stable.

## Documents

- Draft Community Group Report, 13 November 2026: <https://webmachinelearning.github.io/webmcp/>
  Editors: Brandon Walderman and Samuel Dallstream (Microsoft); Khushal Sagar and Dominic Farolino (Google). Status text: not a W3C Standard and not on the W3C Standards Track.
- Explainer: <https://github.com/webmachinelearning/webmcp>
- Chrome overview, published 18 May 2026, updated 7 October 2026: <https://developer.chrome.com/docs/ai/webmcp>
- Imperative API, updated 16 October 2026: <https://developer.chrome.com/docs/ai/webmcp/imperative-api>
- Declarative API: <https://developer.chrome.com/docs/ai/webmcp/declarative-api>
- Secure tools: <https://developer.chrome.com/docs/ai/webmcp/secure-tools>
- Best practices: <https://developer.chrome.com/docs/ai/webmcp/best-practices>
- Agentic JavaScript tools guide: <https://developer.chrome.com/docs/modern-web-guidance/guides/webmcp/agentic-javascript-tools>
- Agentic forms guide: <https://developer.chrome.com/docs/modern-web-guidance/guides/webmcp/agentic-forms>
- Lighthouse Agentic Browsing scoring: <https://developer.chrome.com/docs/lighthouse/agentic-browsing/scoring>
- Agent-ready toolkit (Chrome blog): <https://developer.chrome.com/blog/agent-ready-toolkit>
- DevTools for agents, WebMCP debugging: <https://developer.chrome.com/docs/devtools/agents/webmcp-debugging>
- Modern Web Guidance: <https://github.com/GoogleChrome/modern-web-guidance> and npm package `modern-web-guidance`
- Types package `webmcp-types` 0.1.10: <https://www.npmjs.com/package/webmcp-types>
- Move off `navigator.modelContext`: <https://github.com/angular/angular/issues/68947>, spec issue <https://github.com/webmachinelearning/webmcp/issues/173>, spec PR <https://github.com/webmachinelearning/webmcp/pull/184>

## The API this generator targets

The 13 November 2026 draft puts the model context on the document:

```webidl
partial interface Document {
  [SecureContext, SameObject] readonly attribute ModelContext modelContext;
};
```

`ModelContext` extends `EventTarget` and has `registerTool`, `getTools`, and `executeTool`, plus `toolchange`, `toolactivated`, and `toolcancel`.

A tool dictionary has `name`, optional `title`, `description`, optional `inputSchema` and `outputSchema`, `execute`, and optional `annotations`. The name is 1–128 characters from ASCII letters, digits, `_`, `-`, and `.`. An empty description is rejected. A duplicate name is rejected with `InvalidStateError`.

`execute` is called with the input object and a `ToolExecuteCallbackOptions` dictionary whose `signal` aborts that invocation. Registration takes an optional `AbortSignal` that unregisters the tool, and an optional `exposedTo` list of trustworthy origins. There is no `unregisterTool()` in this draft.

Annotations, all defaulting to false:

| Field | Meaning in the draft |
| --- | --- |
| `readOnlyHint` | The tool does not modify state. |
| `untrustedContentHint` | The output contains data the registering author does not trust. |
| `consequentialHint` | The action is significant, real-world, or hard to undo. The secure-tools note says clients can require a user prompt before those calls. |
| `debugging` | The tool is for developer tooling rather than end users. |

The `tools` permissions-policy feature defaults to `self`. Cross-origin frames need `allow="tools"`. Cross-origin discovery also needs `exposedTo` on the producer and `fromOrigins` on the consumer.

`executeTool` resolves to a string. The draft says that string is the JSON serialization of the callback's return value. Chrome's October docs show a string return logged without extra quotes.

## What was checked in Chrome 157

Local Chrome was `Google Chrome 157.0.8103.50`. A headless page on `http://127.0.0.1` was driven over the DevTools protocol.

| Launch flag | `document.modelContext` | `navigator.modelContext` |
| --- | --- | --- |
| `--enable-webmcp-testing` | `undefined` | `undefined` |
| `--enable-features=WebMCP` | object with `registerTool` | `undefined` |
| `--enable-features=WebMCP,DeclarativeWebMCP` | object | `undefined` |
| `--enable-blink-features=WebMCP,DeclarativeWebMCP` | object | `undefined` |

The documented flag `chrome://flags/#enable-webmcp-testing` maps to a switch named `enable-webmcp-testing` in this binary, and that switch alone did not expose the API in this headless run. The feature that did is `WebMCP`. This was not compared with the headed `chrome://flags` UI.

With `WebMCP` and `DeclarativeWebMCP` enabled, a page script observed:

- Prototype methods: `registerTool`, `getTools`, `executeTool`, and the three event-handler properties.
- A second `registerTool` with the same name rejected as `InvalidStateError: Duplicate tool name`.
- A name containing a space rejected as `InvalidStateError`.
- Aborting the registration signal removed the tool from a later `getTools()` list. `getTools()` names were sorted.
- Annotations round-tripped, including `debugging: false`.
- `execute` received a second argument whose `signal` property was present.
- `executeTool` results: an object, array, number, boolean, and `null` came back as JSON text (`{"ok":true,"n":1}`, `["a",1]`, `"7"`, `"false"`, `"null"`). A string return came back as that string, not as a quoted JSON string. The in-memory test double follows that Chrome 157 behavior. The draft's wording would also quote strings. ownmcp does not try to paper over the difference outside `serializeToolResult`.
- A form with `toolname="add_item"` and `tooldescription` showed up in `getTools()` beside an imperative tool, and its `inputSchema` was synthesized from the control, including `toolparamdescription`.

`navigator.modelContext` was `undefined`, so the generator does not fall back to it. The May 2026 early-preview note (`document.modelContext || navigator.modelContext`, cited in the Angular issue) described Chrome 150, where the navigator alias was deprecated and still present. It was not present in this 157 build.

## Declarative API versus the spec text

Chrome's declarative docs and the Modern Web Guidance forms guide describe `toolname`, `tooldescription`, `toolparamdescription`, and `toolautosubmit` on ordinary forms. The headless probe above showed Chrome 157 registering such a form when `DeclarativeWebMCP` is enabled.

The explainer README, fetched the same day, still says the declarative form API is future exploration and is not part of the specification, and that the imperative API is what the specification defines. The 13 November draft text that was fetched is organized around `document.modelContext` and does not define those HTML attributes.

ownmcp's primary output is imperative `registerTool` code, which both the draft and Chrome document. The North Pantry page also carries the Chrome form attributes, because Lighthouse's form-coverage audit looks for them and because Chrome already registers them. The generated review note says when a form and a script would register the same name. In Chrome 157 the second registration throws, and `browser.js` catches that and leaves the existing tool in place.

## Confirmation

`consequentialHint` is a hint. The draft's security section says a client or agent can require a user prompt before a consequential tool. It does not define a page API that blocks `execute` until a person confirms. Open explainer questions on user prompting are issues [165](https://github.com/webmachinelearning/webmcp/issues/165) and [50](https://github.com/webmachinelearning/webmcp/issues/50).

ownmcp therefore does two separate things:

1. Sets `consequentialHint: true` on every state-changing tool, and `readOnlyHint: true` on reads. The hint is broader than the spec's examples (booking, paying, deleting). `REVIEW.md` says to clear it for a reversible mutation.
2. Calls `requireConfirmation()` inside the generated `execute` before `fetch`. The caller must pass a `confirm` function that returns `true`. In `browser.js` that function is `window.confirm`. This gate is library behavior, not a WebMCP feature.

`untrustedContentHint` is emitted as false, with a review note. The generator does not guess which responses are user-generated.

## The "webmcp skill"

Chrome's agent-ready toolkit blog says Modern Web Guidance includes a `webmcp` skill so a coding agent can implement WebMCP. The skill repository is [GoogleChrome/modern-web-guidance](https://github.com/GoogleChrome/modern-web-guidance), published as the npm package `modern-web-guidance` (1.0.0 was the version listed on 13 November 2026, updated 10 November 2026). The skill ids called out there are `webmcp`, `agentic-javascript-tools`, and `agentic-forms`.

Origin-trial guides are hidden from `retrieve` until someone runs:

```bash
npx modern-web-guidance@latest set-allow-origin-trials
```

That writes `{"allowOriginTrials": true}` to `.mwgrc`. The caution on the agentic-javascript-tools page says this gate exists so coding agents do not adopt an unstable API without an explicit opt-in.

This is a skill package maintained with the Chrome team, not a file found inside the Chrome 157 binary that was searched here. Separately, Chrome DevTools for agents documents `list_webmcp_tools` and `execute_webmcp_tool` for debugging tools in a live browser: <https://developer.chrome.com/docs/devtools/agents/webmcp-debugging>. Those were not invoked in this project.

## Lighthouse Agentic Browsing

The scoring doc says the category is experimental, needs Chrome 150 or later, and that WebMCP audits need the origin trial. It also says the category is not a weighted 0–100 score. Lighthouse gathers it through the Chrome DevTools Protocol `WebMCP` domain. The same doc says the audits are deterministic enough for CI, with the caveat that imperative registration timing can change what a run captures.

`npm run lighthouse` ran Lighthouse 13.6.0 headless against the demo. The command is `scripts/lighthouse.mjs`. It passed Chrome `--headless=new --no-sandbox --disable-gpu --enable-features=WebMCP,DeclarativeWebMCP`.

Recorded result, `fetchTime` `2026-11-13T19:15:46.457Z`, URL `http://127.0.0.1:44741/`, saved in [lighthouse-agentic.json](lighthouse-agentic.json):

| Audit id | Score | Display |
| --- | --- | --- |
| `agent-accessibility-tree` | 1, binary | All audits passed |
| `webmcp-form-coverage` | 1, binary | |
| `webmcp-registered-tools` | 1, informative | Tools: `get_cart`, `list_orders`, `list_products` (imperative, from `browser.js`), `add_to_cart`, `place_order` (declarative, from the forms) |
| `webmcp-schema-validity` | 1, binary | |
| `cumulative-layout-shift` | 1, numeric | display value `0.027` (raw main-frame value in the full report: `0.027429236792522377`) |
| `llms-txt` | 1, binary | |
| `ard-schema` | null, not applicable | The demo does not serve an ARD manifest |

The category object on that run had `score: 1`. That is the CLI's number, not a converted percentage. The full Lighthouse JSON is written to `docs/lighthouse-full.json` and is gitignored because it is large and local.

A run without `WebMCP` enabled was not given its own Lighthouse report. The earlier DevTools probe is the evidence that the API is absent unless the feature is on, which would make the WebMCP audits not applicable.

## Types

Chrome's imperative-API page recommends the `webmcp-types` package. ownmcp does not depend on it. The dictionary ownmcp registers is declared in `src/api/surface.ts`, next to the single read of `document.modelContext`. That keeps a spec rename in one file at the cost of drifting if the draft adds a required member we do not copy. The members we emit were the ones Chrome 157 accepted on 13 November 2026: `name`, `title`, `description`, `inputSchema`, `annotations` (`readOnlyHint`, `untrustedContentHint`, `consequentialHint`, `debugging`), and `execute(input, { signal })`.

## What was not done

- No origin-trial token was requested, and no feedback was sent to Chrome or the community group.
- No issue or pull request was opened on the spec, Chrome, or any other repo.
- DevTools for agents' `list_webmcp_tools` / `execute_webmcp_tool` were not called.
- A model was not asked to choose tools and complete a shop task.
- `executeTool`'s `OperationError` wrapping of a thrown callback was not re-measured. The draft says callers observe `OperationError` rather than the page's exception. The test double does not do that wrapping.
- Service-worker WebMCP, cross-origin `exposedTo`, and the `toolchange` event were not exercised.
- The headed chrome://flags page was not clicked; only command-line switches were.
