/**
 * The only module that knows how WebMCP is spelled.
 *
 * Draft Community Group Report, 13 November 2026:
 * https://webmachinelearning.github.io/webmcp/
 * Each Document has `modelContext`. `registerTool`, `getTools`, and
 * `executeTool` live there. `navigator.modelContext` is not read: in Chrome
 * 157.0.8103.50 with `--enable-features=WebMCP` it was `undefined`.
 *
 * `createMemoryModelContext()` is a same-document test double. It is not a
 * browser polyfill and it does not implement permissions policy, cross-origin
 * exposure, or the spec's OperationError wrapping.
 */

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  untrustedContentHint?: boolean;
  consequentialHint?: boolean;
  debugging?: boolean;
}

export interface WebMcpTool {
  name: string;
  title?: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  annotations?: ToolAnnotations;
  execute: (
    input: Record<string, unknown>,
    agent?: { signal?: AbortSignal },
  ) => Promise<unknown> | unknown;
}

export interface RegisteredToolRef {
  name: string;
  title: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  annotations?: ToolAnnotations;
}

export interface ModelContextLike {
  registerTool(tool: WebMcpTool, options?: { signal?: AbortSignal }): Promise<void>;
  getTools(): Promise<RegisteredToolRef[]>;
  executeTool(
    tool: { name: string },
    input?: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<string>;
}

/** Page expression for the model context. Change this if the spec moves again. */
export const WEBMCP_MODEL_CONTEXT_EXPRESSION = "document.modelContext";

export const WEBMCP_REGISTER_METHOD = "registerTool";

export const ANNOTATION_KEYS = {
  readOnlyHint: "readOnlyHint",
  untrustedContentHint: "untrustedContentHint",
  consequentialHint: "consequentialHint",
  debugging: "debugging",
} as const;

const TOOL_NAME = /^[A-Za-z0-9._-]{1,128}$/;

export function assertToolName(name: string): void {
  if (!TOOL_NAME.test(name)) {
    throw Object.assign(new Error(`Invalid WebMCP tool name: ${name}`), {
      name: "InvalidStateError",
    });
  }
}

/**
 * Chrome 157 `executeTool` return values measured on 2026-11-13:
 * strings are returned unchanged; everything else is JSON text.
 * The spec text says every result is serialized to a JSON string, which would
 * quote strings. This helper follows the browser we measured.
 */
export function serializeToolResult(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "undefined") {
    throw new TypeError("Tool result is undefined and cannot be serialized");
  }
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new TypeError("Tool result cannot be serialized");
  }
  return json;
}

export function browserModelContext(
  scope: typeof globalThis = globalThis,
): ModelContextLike | undefined {
  const host = scope as typeof globalThis & {
    document?: { modelContext?: ModelContextLike };
  };
  const found = host.document?.modelContext;
  if (!found || typeof found.registerTool !== "function") return undefined;
  return found;
}

export function createMemoryModelContext(): ModelContextLike {
  const tools = new Map<string, WebMcpTool>();

  return {
    async registerTool(tool, options = {}) {
      assertToolName(tool.name);
      if (!tool.description) {
        throw Object.assign(new Error("Tool description is empty"), {
          name: "InvalidStateError",
        });
      }
      if (tools.has(tool.name)) {
        throw Object.assign(new Error("Duplicate tool name"), {
          name: "InvalidStateError",
        });
      }
      if (options.signal?.aborted) {
        throw options.signal.reason ?? new Error("The registration signal is already aborted");
      }
      tools.set(tool.name, tool);
      const onAbort = () => {
        tools.delete(tool.name);
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
    },

    async getTools() {
      return [...tools.values()]
        .map((tool) => ({
          name: tool.name,
          title: tool.title ?? "",
          description: tool.description,
          ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
          ...(tool.annotations ? { annotations: tool.annotations } : {}),
        }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    },

    async executeTool(tool, input = {}, options = {}) {
      const found = tools.get(tool.name);
      if (!found) {
        throw Object.assign(new Error(`Tool not found: ${tool.name}`), {
          name: "NotFoundError",
        });
      }
      if (options.signal?.aborted) {
        throw options.signal.reason ?? new Error("The execution signal is already aborted");
      }
      const value = await found.execute(input, { signal: options.signal });
      return serializeToolResult(value);
    },
  };
}

export async function registerOwnedTools(
  tools: readonly WebMcpTool[],
  options: { context?: ModelContextLike; signal?: AbortSignal } = {},
): Promise<ModelContextLike> {
  const context = options.context ?? browserModelContext();
  if (!context) {
    throw new Error(
      `${WEBMCP_MODEL_CONTEXT_EXPRESSION} is missing. Chrome 157 exposes it with --enable-features=WebMCP; --enable-webmcp-testing alone did not. navigator.modelContext is not used. Pass createMemoryModelContext() in tests.`,
    );
  }
  for (const tool of tools) {
    await context.registerTool(tool, options.signal ? { signal: options.signal } : {});
  }
  return context;
}
