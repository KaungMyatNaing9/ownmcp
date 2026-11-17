import type { ToolEffect } from "../model/types.ts";

export class ConfirmationRequiredError extends Error {
  readonly toolName: string;

  constructor(toolName: string) {
    super(
      `Refusing to run state-changing tool "${toolName}" until confirm() returns true.`,
    );
    this.name = "ConfirmationRequiredError";
    this.toolName = toolName;
  }
}

export interface ConfirmRequest {
  name: string;
  input: unknown;
}

export type ConfirmFn = (request: ConfirmRequest) => boolean | Promise<boolean>;

/**
 * Owner-side gate. WebMCP's consequentialHint only asks a client to prompt;
 * the 13 November 2026 draft does not let the page require that prompt.
 */
export async function requireConfirmation(
  effect: ToolEffect,
  name: string,
  input: unknown,
  confirm: ConfirmFn | undefined,
): Promise<void> {
  if (effect === "read") return;
  if (!confirm) throw new ConfirmationRequiredError(name);
  const allowed = await confirm({ name, input });
  if (allowed !== true) throw new ConfirmationRequiredError(name);
}
