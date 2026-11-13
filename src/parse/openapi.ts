import type { HttpMethod, JsonSchema, SpecOperation, ToolParam } from "../model/types.ts";
import { isLoopback } from "./http.ts";

const METHODS = new Set<HttpMethod>(["GET", "POST", "PUT", "PATCH", "DELETE"]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function isHttpMethod(value: string): value is HttpMethod {
  return METHODS.has(value as HttpMethod);
}

function schemaOf(value: unknown, resolve: (ref: string) => unknown, depth = 0): JsonSchema {
  const record = asRecord(value);
  if (!record) return { type: "string" };
  if (typeof record.$ref === "string") {
    if (depth > 4) return { type: "object", description: "Unresolved nested schema" };
    return schemaOf(resolve(record.$ref), resolve, depth + 1);
  }
  const schema: JsonSchema = {};
  if (record.type === "integer") schema.type = "integer";
  else if (record.type === "number") schema.type = "number";
  else if (record.type === "boolean") schema.type = "boolean";
  else if (record.type === "array") schema.type = "array";
  else if (record.type === "object") schema.type = "object";
  else if (record.type === "string" || record.type === undefined) schema.type = "string";
  if (typeof record.description === "string") schema.description = record.description;
  if (typeof record.format === "string") schema.format = record.format;
  if (typeof record.minimum === "number") schema.minimum = record.minimum;
  if (typeof record.maximum === "number") schema.maximum = record.maximum;
  if (typeof record.minLength === "number") schema.minLength = record.minLength;
  if (typeof record.maxLength === "number") schema.maxLength = record.maxLength;
  if (typeof record.default === "string" || typeof record.default === "number" || typeof record.default === "boolean") {
    schema.default = record.default;
  }
  if (Array.isArray(record.enum)) {
    schema.enum = record.enum.filter(
      (item): item is string | number | boolean =>
        typeof item === "string" || typeof item === "number" || typeof item === "boolean",
    );
  }
  if (schema.type === "array" && record.items) schema.items = schemaOf(record.items, resolve, depth + 1);
  if (schema.type === "object" && asRecord(record.properties)) {
    schema.properties = {};
    for (const [key, property] of Object.entries(asRecord(record.properties) ?? {})) {
      schema.properties[key] = schemaOf(property, resolve, depth + 1);
    }
    if (Array.isArray(record.required)) {
      schema.required = record.required.filter((item): item is string => typeof item === "string");
    }
  }
  return schema;
}

function checkServers(document: Record<string, unknown>, owner: URL, notes: string[]): void {
  if (!Array.isArray(document.servers) || document.servers.length === 0) return;
  const origins: URL[] = [];
  for (const server of document.servers) {
    const record = asRecord(server);
    if (!record || typeof record.url !== "string") continue;
    try {
      origins.push(new URL(record.url, owner));
    } catch {
      notes.push(`Ignored an OpenAPI server URL that did not parse: ${String(record.url)}`);
    }
  }
  if (origins.length === 0) return;
  if (origins.some((url) => url.origin === owner.origin)) {
    const others = origins.filter((url) => url.origin !== owner.origin);
    if (others.length > 0) {
      notes.push(`OpenAPI lists other servers that were not used: ${others.map((url) => url.origin).join(", ")}`);
    }
    return;
  }
  const loopbackOnly = origins.every((url) => isLoopback(url.hostname)) && isLoopback(owner.hostname);
  if (loopbackOnly) {
    notes.push(
      `OpenAPI server port differs from --origin (${origins.map((url) => url.origin).join(", ")}). Paths were kept because both hosts are loopback.`,
    );
    return;
  }
  throw new Error(
    `Refusing OpenAPI servers that are not the declared owner origin ${owner.origin}: ${origins.map((url) => url.origin).join(", ")}`,
  );
}

export function parseOpenApi(document: unknown, owner: URL): { operations: SpecOperation[]; notes: string[] } {
  const root = asRecord(document);
  if (!root) throw new Error("OpenAPI document must be a JSON object");
  const version = typeof root.openapi === "string" ? root.openapi : "";
  if (!version.startsWith("3.")) throw new Error("Only OpenAPI 3 JSON is supported");
  const notes: string[] = [];
  checkServers(root, owner, notes);
  const components = asRecord(root.components);
  const schemas = asRecord(components?.schemas) ?? {};
  const resolve = (ref: string): unknown => {
    const prefix = "#/components/schemas/";
    if (!ref.startsWith(prefix)) throw new Error(`Unsupported $ref ${ref}`);
    const found = schemas[ref.slice(prefix.length)];
    if (!found) throw new Error(`Missing schema ${ref}`);
    return found;
  };
  const paths = asRecord(root.paths);
  if (!paths) throw new Error("OpenAPI document is missing paths");
  const operations: SpecOperation[] = [];

  for (const [path, pathItem] of Object.entries(paths)) {
    const item = asRecord(pathItem);
    if (!item || !path.startsWith("/")) continue;
    const shared = Array.isArray(item.parameters) ? item.parameters : [];
    for (const [methodName, operationValue] of Object.entries(item)) {
      if (!isHttpMethod(methodName.toUpperCase())) continue;
      const operation = asRecord(operationValue);
      if (!operation) continue;
      const method = methodName.toUpperCase() as HttpMethod;
      const params: ToolParam[] = [];
      const rawParams = [...shared, ...(Array.isArray(operation.parameters) ? operation.parameters : [])];
      for (const raw of rawParams) {
        const parameter = asRecord(raw);
        if (!parameter || typeof parameter.name !== "string") continue;
        const located = parameter.in;
        if (located !== "path" && located !== "query") {
          notes.push(`Ignored OpenAPI ${String(located)} parameter ${parameter.name} on ${method} ${path}`);
          continue;
        }
        params.push({
          name: parameter.name,
          located,
          required: located === "path" ? true : parameter.required === true,
          schema: schemaOf(parameter.schema, resolve),
        });
      }
      let bodyStyle: SpecOperation["bodyStyle"] = "none";
      const requestBody = asRecord(operation.requestBody);
      const content = asRecord(requestBody?.content);
      const jsonBody = asRecord(content?.["application/json"]);
      const formBody = asRecord(content?.["application/x-www-form-urlencoded"]);
      const chosen = jsonBody ?? formBody;
      if (chosen) {
        bodyStyle = jsonBody ? "json" : "form";
        const bodySchema = schemaOf(chosen.schema, resolve);
        const required = new Set(bodySchema.required ?? []);
        for (const [name, schema] of Object.entries(bodySchema.properties ?? {})) {
          params.push({
            name,
            located: "body",
            required: requestBody?.required === false ? false : required.has(name),
            schema,
          });
        }
      }
      const declared = new Set(params.filter((param) => param.located === "path").map((param) => param.name));
      for (const match of path.matchAll(/\{([^}]+)\}/g)) {
        const name = match[1] ?? "";
        if (!name || declared.has(name)) continue;
        params.push({
          name,
          located: "path",
          required: true,
          schema: { type: "string", description: "Path parameter inferred from the template." },
        });
        notes.push(`OpenAPI path ${path} uses {${name}} without a path parameter declaration.`);
      }
      operations.push({
        source: "openapi",
        method,
        path,
        ...(typeof operation.operationId === "string" ? { operationId: operation.operationId } : {}),
        ...(typeof operation.summary === "string" ? { summary: operation.summary } : {}),
        ...(typeof operation.description === "string" ? { description: operation.description } : {}),
        params,
        bodyStyle,
      });
    }
  }
  return { operations, notes };
}
