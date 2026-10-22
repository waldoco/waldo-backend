// Tool definitions from an owner-connected MCP server. Everything here is server-written and untrusted:
// annotations are hints, descriptions are data shown to the model as the server's own words. What Waldo
// relies on is the digest of each definition, pinned when the owner decided how the tool may run.
import { headerValue } from './mcp-protocol.ts';

export type McpToolDef = Readonly<{
  name: string;
  title?: string;
  description?: string;
  inputSchema: Readonly<Record<string, unknown>>;
  annotations?: Readonly<Record<string, unknown>>;
}>;
export type ToolsPage = Readonly<{ tools: readonly McpToolDef[]; nextCursor?: string; ttlMs?: number; dropped: readonly Readonly<{ name: string; reason: string }>[] }>;

// The spec's SHOULD for tool names (1-128 of A-Z a-z 0-9 _ - .), enforced: a name is an identifier in
// Waldo's arguments, cards and headers, so a name carrying spaces, newlines or prose is dropped.
export const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const HEADER_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

// x-mcp-header rules (spec, Custom Headers from Tool Parameters): a token, unique case-insensitively,
// only on primitive (not number) properties reachable through a chain of `properties` keys. A violation
// anywhere makes the whole definition invalid.
const headerAnnotations = (schema: Record<string, unknown>): Readonly<{ ok: true; paths: readonly Readonly<{ header: string; path: readonly string[] }>[] } | { ok: false }> => {
  const found: { header: string; path: string[] }[] = [];
  let bad = false;
  const walk = (node: unknown, path: string[] | null) => {
    if (Array.isArray(node)) { for (const item of node) walk(item, null); return; }
    if (!isObject(node)) return;
    if (Object.hasOwn(node, 'x-mcp-header')) {
      const header = node['x-mcp-header'], type = node.type;
      if (path === null || path.length === 0 || typeof header !== 'string' || !HEADER_TOKEN.test(header) || !['string', 'integer', 'boolean'].includes(type as string)) bad = true;
      else found.push({ header, path });
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'properties' && isObject(value) && path !== null) {
        for (const [prop, child] of Object.entries(value)) walk(child, [...path, prop]);
      } else if (key !== 'x-mcp-header') walk(value, null);
    }
  };
  walk(schema, []);
  const names = found.map((item) => item.header.toLowerCase());
  return bad || new Set(names).size !== names.length ? { ok: false } : { ok: true, paths: found };
};

export const parseToolsPage = (result: unknown): ToolsPage => {
  if (!isObject(result) || !Array.isArray(result.tools)) throw new Error('mcp_tools_list_malformed');
  const tools: McpToolDef[] = [], dropped: { name: string; reason: string }[] = [], seen = new Set<string>();
  for (const raw of result.tools) {
    const name = isObject(raw) && typeof raw.name === 'string' ? raw.name : '';
    const label = TOOL_NAME.test(name) ? name : '(unnamed)';
    if (!isObject(raw) || !TOOL_NAME.test(name)) { dropped.push({ name: label, reason: 'invalid_name' }); continue; }
    if (seen.has(name)) { dropped.push({ name, reason: 'duplicate_name' }); continue; }
    const schema = raw.inputSchema;
    if (!isObject(schema) || (schema.type !== undefined && schema.type !== 'object')) { dropped.push({ name, reason: 'invalid_input_schema' }); continue; }
    if (!headerAnnotations(schema).ok) { dropped.push({ name, reason: 'invalid_x_mcp_header' }); continue; }
    seen.add(name);
    tools.push({
      name, inputSchema: schema,
      ...(typeof raw.title === 'string' ? { title: raw.title } : {}),
      ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
      ...(isObject(raw.annotations) ? { annotations: raw.annotations } : {}),
    });
  }
  const ttl = typeof result.ttlMs === 'number' && Number.isFinite(result.ttlMs) && result.ttlMs >= 0 ? result.ttlMs : undefined;
  return { tools, dropped, ...(typeof result.nextCursor === 'string' && result.nextCursor ? { nextCursor: result.nextCursor } : {}), ...(ttl === undefined ? {} : { ttlMs: ttl }) };
};

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
};
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
export const sha256 = async (text: string) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
// Everything the model or the owner judged the tool by. A change to any of it is a different tool.
export const toolDigest = (def: McpToolDef) => sha256(canonical({ name: def.name, title: def.title ?? null, description: def.description ?? null, inputSchema: def.inputSchema, annotations: def.annotations ?? null }));
export const argsDigest = (args: unknown) => sha256(canonical(args));

// The server's own hint, shown to the owner next to the choice. It never decides anything.
export const marksReadOnly = (def: McpToolDef) => def.annotations?.readOnlyHint === true && def.annotations?.destructiveHint !== true;

export const toolHeaders = (def: McpToolDef, args: Readonly<Record<string, unknown>>): Record<string, string> => {
  const parsed = headerAnnotations(def.inputSchema as Record<string, unknown>);
  if (!parsed.ok) return {};
  const headers: Record<string, string> = {};
  for (const { header, path } of parsed.paths) {
    let value: unknown = args;
    for (const key of path) value = isObject(value) ? value[key] : undefined;
    if (value === undefined || value === null) continue;
    if (typeof value === 'string') headers[`mcp-param-${header.toLowerCase()}`] = headerValue(value);
    else if (typeof value === 'boolean') headers[`mcp-param-${header.toLowerCase()}`] = value ? 'true' : 'false';
    else if (typeof value === 'number' && Number.isSafeInteger(value)) headers[`mcp-param-${header.toLowerCase()}`] = String(value);
  }
  return headers;
};

const TYPES: Readonly<Record<string, (value: unknown) => boolean>> = {
  string: (v) => typeof v === 'string', boolean: (v) => typeof v === 'boolean', integer: (v) => typeof v === 'number' && Number.isInteger(v),
  number: (v) => typeof v === 'number' && Number.isFinite(v), object: isObject, array: Array.isArray, null: (v) => v === null,
};
// A first pass before anything leaves Waldo: required properties, top-level types and enums, and unknown
// keys where the schema closes them. The server still validates fully; this catches the model's slips
// with a message it can act on instead of a round trip.
export const checkArgs = (def: McpToolDef, args: Readonly<Record<string, unknown>>): string | null => {
  const schema = def.inputSchema, props = isObject(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === 'string') : [];
  const missing = required.filter((key) => !Object.hasOwn(args, key));
  if (missing.length) return `missing required argument${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`;
  if (schema.additionalProperties === false) {
    const unknown = Object.keys(args).filter((key) => !Object.hasOwn(props, key));
    if (unknown.length) return `unknown argument${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`;
  }
  for (const [key, value] of Object.entries(args)) {
    const prop = props[key];
    if (!isObject(prop)) continue;
    const types = typeof prop.type === 'string' ? [prop.type] : Array.isArray(prop.type) ? prop.type.filter((t): t is string => typeof t === 'string') : [];
    if (types.length && !types.some((type) => TYPES[type]?.(value) ?? true)) return `argument ${key} must be ${types.join(' or ')}`;
    if (Array.isArray(prop.enum) && !prop.enum.some((option) => canonical(option) === canonical(value))) return `argument ${key} must be one of ${prop.enum.map((v) => JSON.stringify(v)).join(', ')}`;
  }
  return null;
};

// Retrieval, not judgment: rank by how many of the query's words appear in the name, title or
// description, name hits first. An empty query keeps the server's own order.
export const rankTools = <T extends Readonly<{ def: McpToolDef }>>(items: readonly T[], query: string | undefined): readonly T[] => {
  const words = (query ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 1);
  if (!words.length) return items;
  const scored = items.map((item, index) => {
    const name = item.def.name.toLowerCase().replace(/[_.-]+/g, ' '), text = `${item.def.title ?? ''} ${item.def.description ?? ''}`.toLowerCase();
    const score = words.reduce((sum, word) => sum + (name.includes(word) ? 3 : 0) + (text.includes(word) ? 1 : 0), 0);
    return { item, index, score };
  });
  return scored.filter((row) => row.score > 0).sort((a, b) => b.score - a.score || a.index - b.index).map((row) => row.item);
};
