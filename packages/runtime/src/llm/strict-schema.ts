// Strict here means only well-formed calls: valid JSON, every required field, the right types. It never narrows a tool.
// OpenAI strict function calling (Structured Outputs, "Supported schemas"): every object lists all its properties as
// required and sets additionalProperties false, an optional field becomes a union with null, the root is an object,
// and only a documented subset of JSON Schema is accepted; a schema outside it is a request error. A tool whose schema
// cannot be shown to sit inside that subset is sent non-strict. A pattern is dropped although the subset allows one:
// zod writes it in JavaScript regex syntax, the provider compiles only a subset of regex, and a pattern it cannot compile
// fails the whole request. The tool's own schema still validates every call after it arrives, so a constraint dropped
// here (a pattern, a bound, an unlisted format, a default) is still enforced.
type Json = Record<string, unknown>;

const KEPT = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'anyOf', 'enum', 'description', 'format', '$ref', '$defs']);
// Bounds stay with the tool's own schema. Constrained decoding would make the model stop at a maxLength or maxItems and
// send a cut-off body or list that then passes validation; checked after the call, an oversize argument is refused with
// a fix the model can act on (page, split, narrow).
const BOUNDS = ['minLength', 'maxLength', 'multipleOf', 'maximum', 'exclusiveMaximum', 'minimum', 'exclusiveMinimum', 'minItems', 'maxItems'];
const DROPPED = new Set(['$schema', 'default', 'title', 'pattern', 'examples', '$id', '$comment', 'readOnly', 'writeOnly', 'deprecated', ...BOUNDS]);
const FORMATS = new Set(['date-time', 'time', 'date', 'duration', 'email', 'hostname', 'ipv4', 'ipv6', 'uuid']);

class Unsupported extends Error {}

const isObject = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value);
const acceptsNull = (schema: unknown): boolean => isObject(schema) && (
  schema.type === 'null' || (Array.isArray(schema.type) && schema.type.includes('null'))
  || (Array.isArray(schema.anyOf) && schema.anyOf.some(acceptsNull)) || (Array.isArray(schema.enum) && schema.enum.includes(null)));

function strictNode(node: unknown): Json {
  if (!isObject(node)) throw new Unsupported();
  const out: Json = {};
  for (const [key, value] of Object.entries(node)) {
    if (DROPPED.has(key)) continue;
    if (key === 'const') { out.enum = [value]; continue; }
    if (!KEPT.has(key)) throw new Unsupported();
    if (key === 'format') { if (typeof value === 'string' && FORMATS.has(value)) out.format = value; continue; }
    out[key] = value;
  }
  if (Array.isArray(out.anyOf)) out.anyOf = out.anyOf.map(strictNode);
  if (out.items !== undefined) {
    if (!isObject(out.items)) throw new Unsupported();
    out.items = strictNode(out.items);
  }
  if (isObject(out.$defs)) out.$defs = Object.fromEntries(Object.entries(out.$defs).map(([name, def]) => [name, strictNode(def)]));
  const isObjectType = out.type === 'object' || out.properties !== undefined;
  if (isObjectType) {
    if (out.additionalProperties !== undefined && out.additionalProperties !== false) throw new Unsupported();
    if (!isObject(out.properties)) throw new Unsupported();
    const required = new Set(Array.isArray(out.required) ? out.required as string[] : []);
    out.properties = Object.fromEntries(Object.entries(out.properties).map(([name, property]) => {
      const strict = strictNode(property);
      return [name, required.has(name) || acceptsNull(strict) ? strict : { anyOf: [strict, { type: 'null' }] }];
    }));
    out.required = Object.keys(out.properties as Json);
    out.additionalProperties = false;
  }
  return out;
}

// The strict form of a tool's parameters, or null when they fall outside the documented subset.
export function openAIStrictParameters(parameters: Json): Json | null {
  if (parameters.type !== 'object' || parameters.anyOf !== undefined) return null;
  try {
    return strictNode(parameters);
  } catch (error) {
    if (error instanceof Unsupported) return null;
    throw error;
  }
}

function resolve(schema: unknown, root: Json): unknown {
  if (!isObject(schema) || typeof schema.$ref !== 'string') return schema;
  if (schema.$ref === '#') return root;
  const match = /^#\/\$defs\/(.+)$/.exec(schema.$ref);
  return match && isObject(root.$defs) ? root.$defs[match[1]!] : undefined;
}

// Strict mode returns null for a field the model left out. The tool's own schema reads an absent field, so a null the
// original schema does not accept is removed before the call leaves the adapter: dispatch validation, the loop's repeat
// key and an approval card's argument digest all see the arguments as the tool defines them.
function withoutStrictNulls(value: unknown, schema: unknown, root: Json): unknown {
  const node = resolve(schema, root);
  if (!isObject(node)) return value;
  if (Array.isArray(value)) return node.items === undefined ? value : value.map((item) => withoutStrictNulls(item, node.items, root));
  if (!isObject(value)) return value;
  if (Array.isArray(node.anyOf)) {
    const branch = node.anyOf.map((option) => resolve(option, root)).find((option) => isObject(option) && isObject(option.properties)
      && Object.keys(value).every((key) => key in (option.properties as Json)));
    return branch === undefined ? value : withoutStrictNulls(value, branch, root);
  }
  if (!isObject(node.properties)) return value;
  const required = new Set(Array.isArray(node.required) ? node.required as string[] : []);
  const properties = node.properties;
  return Object.fromEntries(Object.entries(value).flatMap(([key, field]) => {
    if (field === null && !required.has(key) && !acceptsNull(resolve(properties[key], root))) return [];
    return [[key, withoutStrictNulls(field, properties[key], root)]];
  }));
}

export function fromOpenAIStrictArguments(args: string, parameters: Json): string {
  let parsed: unknown;
  try { parsed = JSON.parse(args); } catch { return args; }
  const canonical = withoutStrictNulls(parsed, parameters, parameters);
  const text = JSON.stringify(canonical);
  return text === JSON.stringify(parsed) ? args : text;
}
