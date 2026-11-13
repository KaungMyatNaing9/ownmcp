const UNSAFE_SEGMENT = /^(?:\.\.?|%2e|%2e%2e)$/i;

function assertRelativePath(path: string): void {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || path.includes("?") || path.includes("#")) {
    throw new Error(`Refusing an unsafe path: ${path}`);
  }
  for (const segment of path.split("/")) {
    if (UNSAFE_SEGMENT.test(segment)) {
      throw new Error(`Refusing an unsafe path: ${path}`);
    }
  }
}

export function fillPath(template: string, input: Record<string, unknown>): string {
  const param = /\{([A-Za-z0-9_]+)\}/g;
  assertRelativePath(template.replace(param, "x"));
  if (template.includes("..")) throw new Error(`Refusing an unsafe path template: ${template}`);
  const missing: string[] = [];
  const filled = template.replace(/\{([A-Za-z0-9_]+)\}/g, (_match, name: string) => {
    const value = input[name];
    if (value === undefined || value === null || value === "") {
      missing.push(name);
      return "";
    }
    return encodeURIComponent(String(value));
  });
  if (missing.length > 0) {
    throw new Error(`Missing path parameter ${missing.join(", ")}`);
  }
  if (filled.includes("{") || filled.includes("}")) {
    throw new Error("Unresolved path template");
  }
  assertRelativePath(filled);
  return filled;
}

/** Resolve a path against the owner's origin and refuse to leave it. */
export function ownerUrl(baseUrl: string, path: string): URL {
  assertRelativePath(path);
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new Error("baseUrl is not a URL");
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new Error("baseUrl must be http or https");
  }
  const url = new URL(path, base.origin);
  if (url.origin !== base.origin) {
    throw new Error("Refusing to leave the owner origin");
  }
  return url;
}
