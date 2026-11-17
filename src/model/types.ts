/**
 * Intermediate tool description. The WebMCP dictionary shape lives in
 * src/api/surface.ts; this file is the generator's own model.
 */

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type ToolEffect = "read" | "state-changing";

export type BodyStyle = "json" | "form" | "none";

export type ParamLocation = "path" | "query" | "body";

export interface JsonSchema {
  type?: "string" | "number" | "integer" | "boolean" | "object" | "array";
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: Array<string | number | boolean>;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  format?: string;
  default?: string | number | boolean;
}

export interface ToolParam {
  name: string;
  located: ParamLocation;
  required: boolean;
  schema: JsonSchema;
}

export interface OwnedTool {
  name: string;
  title: string;
  description: string;
  effect: ToolEffect;
  method: HttpMethod;
  path: string;
  params: ToolParam[];
  bodyStyle: BodyStyle;
  sample: Record<string, unknown>;
  sampleReady: boolean;
  sources: string[];
  reviewNotes: string[];
}

export interface CallSample {
  source: "har" | "playwright";
  method: string;
  pathname: string;
  query: Record<string, string>;
  bodyStyle: BodyStyle;
  body?: Record<string, unknown>;
  status?: number;
}

export interface SpecOperation {
  source: "openapi" | "form";
  method: HttpMethod;
  path: string;
  operationId?: string;
  summary?: string;
  description?: string;
  params: ToolParam[];
  bodyStyle: BodyStyle;
}

export interface BuildInput {
  operations: SpecOperation[];
  calls: CallSample[];
  notes: string[];
}

export interface BuildResult {
  tools: OwnedTool[];
  notes: string[];
  skippedStatic: number;
}
