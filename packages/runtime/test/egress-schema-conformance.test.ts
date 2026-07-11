import { describe, expect, it } from 'vitest';
import { EGRESS_TARGET_PATHS } from '../src/hooks/egress-policy';
import { TOOL_ARG_SCHEMAS } from '../src/hooks/registry';

type JsonSchema = Record<string, unknown>;

function isRecord(value: unknown): value is JsonSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function uriPaths(schema: unknown, path: readonly string[] = []): string[] {
  if (!isRecord(schema)) return [];
  if ('$ref' in schema || '$dynamicRef' in schema) {
    throw new Error('URI conformance does not support referenced schemas');
  }

  const paths = schema.format === 'uri' ? [path.join('.')] : [];
  const properties = schema.properties;
  if (isRecord(properties)) {
    for (const [key, value] of Object.entries(properties)) {
      paths.push(...uriPaths(value, [...path, key]));
    }
  }

  if (schema.items !== undefined) {
    paths.push(...uriPaths(schema.items, [...path, '*']));
  }

  for (const key of ['allOf', 'anyOf', 'oneOf'] as const) {
    const branches = schema[key];
    if (Array.isArray(branches)) {
      for (const branch of branches) paths.push(...uriPaths(branch, path));
    }
  }

  if (schema.additionalProperties !== undefined && isRecord(schema.additionalProperties)) {
    const dynamicPaths = uriPaths(schema.additionalProperties, [...path, '*']);
    if (dynamicPaths.length > 0) {
      throw new Error('URI conformance does not support dynamic properties');
    }
  }

  return paths;
}

function declaredUriPaths() {
  return Object.fromEntries(
    Object.entries(EGRESS_TARGET_PATHS)
      .map(
        ([tool, paths]): [string, string[]] => [
          tool,
          (paths ?? [])
            .filter((path) => path.kind === 'url')
            .map((path) => path.path.join('.'))
            .sort(),
        ],
      )
      .filter(([, paths]) => paths.length > 0),
  );
}

function registeredUriPaths() {
  return Object.fromEntries(
    Object.entries(TOOL_ARG_SCHEMAS)
      .map(
        ([tool, schema]): [string, string[]] => [
          tool,
          schema === undefined ? [] : uriPaths(schema.toJSONSchema()).sort(),
        ],
      )
      .filter(([, paths]) => paths.length > 0),
  );
}

function undeclaredUriPaths(
  registered: Record<string, string[]>,
  declared: Record<string, string[]>,
): string[] {
  return Object.entries(registered).flatMap(([tool, paths]) =>
    paths
      .filter((path) => !(declared[tool] ?? []).includes(path))
      .map((path) => `${tool}.${path}`),
  );
}

function schemaAtPath(schema: unknown, path: readonly string[]): unknown {
  if (path.length === 0) return schema;
  if (!isRecord(schema) || '$ref' in schema || '$dynamicRef' in schema) {
    throw new Error('target-path conformance does not support referenced schemas');
  }

  const [segment, ...rest] = path;
  if (segment === '*') return schemaAtPath(schema.items, rest);

  const properties = schema.properties;
  return isRecord(properties) ? schemaAtPath(properties[segment ?? ''], rest) : undefined;
}

describe('egress URL schema conformance', () => {
  it('requires each registered URI argument path to be explicitly declared', () => {
    const declared = declaredUriPaths();
    const registered = registeredUriPaths();

    expect(declared).toEqual(registered);
    expect(undeclaredUriPaths(registered, declared)).toEqual([]);
  });

  it('detects nested URI paths and exposes an undeclared path as a failure', () => {
    const schema = {
      toJSONSchema: () => ({
        type: 'object',
        properties: {
          callbacks: {
            type: 'array',
            items: {
              type: 'object',
              properties: { target: { type: 'string', format: 'uri' } },
            },
          },
        },
      }),
    };

    const paths = uriPaths(schema.toJSONSchema());
    expect(paths).toEqual(['callbacks.*.target']);
    expect(undeclaredUriPaths({ example: paths }, {})).toEqual(['example.callbacks.*.target']);
  });

  it('keeps each declared host or URL path attached to a string argument', () => {
    for (const [tool, paths] of Object.entries(EGRESS_TARGET_PATHS)) {
      const schema = TOOL_ARG_SCHEMAS[tool as keyof typeof TOOL_ARG_SCHEMAS];
      expect(schema).toBeDefined();

      for (const path of paths ?? []) {
        const target = schemaAtPath(schema?.toJSONSchema(), path.path);
        expect(isRecord(target) && target.type === 'string').toBe(true);
      }
    }
  });
});
