import { describe, expect, it } from 'vitest';
import { EGRESS_TARGET_PATHS, OPEN_PUBLIC, evaluateDeclaredEgress } from '../src/hooks/egress-policy';
import { buildSessionState, browseActArgsSchema, type BrowseActArgs, type ToolHandler } from '@waldo/contracts';
import { dispatchTool, type ToolDispatcherContext } from '../src/tools/dispatcher';
import { sanitise } from '../src/scribe/sanitiser';
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

  // Union alternatives share argument locations, not separate egress targets.
  return [...new Set(paths)];
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

function schemasAtPath(schema: unknown, path: readonly string[]): JsonSchema[] {
  if (!isRecord(schema)) return [];
  if ('$ref' in schema || '$dynamicRef' in schema) throw new Error('target-path conformance does not support referenced schemas');
  if (path.length === 0) return [schema];
  const [segment, ...rest] = path;
  const direct = segment === '*' ? schema.items : isRecord(schema.properties) ? schema.properties[segment ?? ''] : undefined;
  return [
    ...schemasAtPath(direct, rest),
    ...['allOf', 'anyOf', 'oneOf'].flatMap(key => Array.isArray(schema[key]) ? schema[key].flatMap(branch => schemasAtPath(branch, path)) : []),
  ];
}

describe('egress URL schema conformance', () => {
  it.each(['goto', 'open_tab'] as const)('blocks a nested %s destination before handler or provider IO, with an allowed positive control', async operation => {
    let handled = 0, issued = 0;
    const provider = async () => { issued++; };
    const handler: ToolHandler<BrowseActArgs, { observed: boolean }, ToolDispatcherContext> = {
      name: 'browse_act', description: 'Read controlled synthetic state', schema: browseActArgsSchema,
      trigger_allowlist: ['user_message'], autonomy_gated: false,
      async handle() { handled++; await provider(); return { ok: true, data: { observed: true }, source_taint: 'external' }; },
    };
    const invoke = (url: string, allowlist = ['example.org']) => dispatchTool({ id: crypto.randomUUID(), name: 'browse_act', args: {
      url: 'https://forms.example.org/form', task: 'Read the synthetic form', command: { operation, url },
    } }, {
      authenticatedUserId: 'synthetic-owner', trigger: 'user_message',
      session: buildSessionState({ trigger: 'user_message', canary_tokens: ['1111111111111111', '2222222222222222', '3333333333333333'], started_at: 1700000000000 }),
      now: () => 1700000000000, rateLimitCheck: () => true, hasApproval: () => true,
      sourceTaint: null, toolArgSourceTaint: null, sanitise, egressAllowlist: allowlist,
    }, { handlers: [handler] });
    for (const url of ['http://127.0.0.1/', 'http://169.254.169.254/', 'https://offsite.example.net/form']) {
      expect(await invoke(url)).toMatchObject({ ok: false, code: 'forbidden' });
      expect(handled).toBe(0); expect(issued).toBe(0);
    }
    expect(await invoke('https://forms.example.org/form', [OPEN_PUBLIC, '-forms.example.org'])).toMatchObject({ ok: false, code: 'forbidden' });
    expect(handled).toBe(0); expect(issued).toBe(0);
    expect(await invoke('https://forms.example.org/form')).toMatchObject({ ok: true });
    expect(handled).toBe(1); expect(issued).toBe(1);
  });

  it('finds union URI paths without vacuous target checks', () => {
    for (const union of ['anyOf', 'oneOf']) {
      const schema = { properties: { command: { [union]: [
        { properties: { url: { type: 'string', format: 'uri' } } },
        { properties: { operation: { type: 'string' } } },
      ] } } };
      expect(uriPaths(schema)).toEqual(['command.url']);
      expect(undeclaredUriPaths({ example: uriPaths(schema) }, {})).toEqual(['example.command.url']);
      expect(schemasAtPath(schema, ['command', 'url'])).toEqual([{ type: 'string', format: 'uri' }]);
      expect(schemasAtPath(schema, ['command', 'absent'])).toEqual([]);
    }
  });

  it('declares a shared URI path once while preserving distinct paths across union branches', () => {
    for (const union of ['allOf', 'anyOf', 'oneOf']) {
      const schema = { properties: { command: { [union]: [
        { properties: { url: { type: 'string', format: 'uri' } } },
        { properties: { url: { type: 'string', format: 'uri' }, callback: { type: 'string', format: 'uri' } } },
      ] } } };
      expect(uriPaths(schema)).toEqual(['command.url', 'command.callback']);
      expect(undeclaredUriPaths({ example: uriPaths(schema) }, { example: ['command.url'] })).toEqual(['example.command.callback']);
    }
  });

  it('applies public, private, blocklist and strict policies to nested destinations', () => {
    const paths = EGRESS_TARGET_PATHS.browse_act!;
    const args = (command: unknown) => ({ url: 'https://forms.example.org/form', command });
    const evaluate = (command: unknown, allowlist = [OPEN_PUBLIC], openPublic = true) => evaluateDeclaredEgress(args(command), paths, allowlist, { openPublic });
    expect(evaluate({ url: 'https://other.example.net/' })).toEqual({ ok: true });
    for (const url of ['http://127.0.0.1/', 'http://169.254.169.254/']) expect(evaluate({ url })).toEqual({ ok: false, reason: 'blocked_host' });
    expect(evaluate({ url: 'https://blocked.example.net/' }, [OPEN_PUBLIC, '-example.net'])).toEqual({ ok: false, reason: 'blocked_host' });
    expect(evaluate('invalid')).toEqual({ ok: false, reason: 'malformed_target' });
    expect(evaluate({ url: 'https://offsite.example.net/' }, ['example.org'], false)).toEqual({ ok: false, reason: 'host_not_allowlisted' });
    expect(evaluate({ url: 'https://forms.example.org/' }, ['example.org'], false)).toEqual({ ok: true });
    expect(evaluate(undefined, ['example.org'], false)).toEqual({ ok: true });
  });

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
        const targets = schemasAtPath(schema?.toJSONSchema(), path.path);
        expect(targets.length).toBeGreaterThan(0);
        expect(targets.every(target => target.type === 'string')).toBe(true);
      }
    }
  });
});
