import { describe, expect, it } from 'vitest';
import { toolParameters, useMacArgsSchema } from '@waldo/contracts';
import { TOOL_ARG_SCHEMAS } from '../src/hooks/registry';

// Anthropic refuses a tool whose input_schema has oneOf, anyOf or allOf at the top level (a 400 on the whole request), so a
// route that falls back to it with such a tool offered fails. Every tool's parameters must be an object at the root.
describe('every tool\'s parameters', () => {
  it.each(Object.entries(TOOL_ARG_SCHEMAS).map(([name, schema]) => [name, schema] as const))('%s is an object at the root, with no union keyword there', (_name, schema) => {
    const root = toolParameters(schema as never);
    expect(root.type).toBe('object');
    for (const keyword of ['oneOf', 'anyOf', 'allOf', 'not', 'enum', 'const']) expect(root).not.toHaveProperty(keyword);
  });

  it('cover the tools the owner is offered, use_mac included', () => {
    expect(Object.keys(TOOL_ARG_SCHEMAS)).toContain('use_mac');
    expect(Object.keys(TOOL_ARG_SCHEMAS).length).toBeGreaterThan(60);
  });
});

describe('use_mac\'s arguments', () => {
  const base = { project: 'waldo', reason: 'check the build' };
  const valid = [
    { ...base, action: 'run_command', command: 'ls' },
    { ...base, action: 'run_command', command: 'ls', timeout_seconds: 30 },
    { ...base, action: 'list_sessions' },
    { ...base, action: 'read_session', session_id: 'sess_1' },
    { ...base, action: 'start_session', agent: 'claude-code', prompt: 'fix it' },
    { ...base, action: 'message_session', session_id: 'sess_1', prompt: 'and tests' },
    { ...base, action: 'interrupt_session', session_id: 'sess_1' },
    { ...base, action: 'stop_session', session_id: 'sess_1' },
  ];
  const invalid = [
    {},
    { ...base },
    { ...base, action: 'format_disk' },
    { ...base, action: 'run_command' },
    { ...base, action: 'run_command', command: '' },
    { ...base, action: 'run_command', command: 'ls', timeout_seconds: 601 },
    { ...base, action: 'run_command', command: 'ls', session_id: 'sess_1' },
    { ...base, action: 'list_sessions', command: 'ls' },
    { ...base, action: 'read_session' },
    { ...base, action: 'read_session', session_id: 'bad id!' },
    { ...base, action: 'start_session', agent: 'gemini', prompt: 'x' },
    { ...base, action: 'start_session', agent: 'codex' },
    { ...base, action: 'message_session', session_id: 'sess_1' },
    { ...base, action: 'stop_session', session_id: 'sess_1', extra: true },
    { action: 'list_sessions', reason: 'no project' },
  ];

  it.each(valid.map((args) => [JSON.stringify(args), args] as const))('accepts %s', (_label, args) => {
    expect(useMacArgsSchema.safeParse(args).success).toBe(true);
  });

  it.each(invalid.map((args) => [JSON.stringify(args), args] as const))('refuses %s', (_label, args) => {
    expect(useMacArgsSchema.safeParse(args).success).toBe(false);
  });

  it('keeps the default timeout and the narrowed type the handler reads', () => {
    const parsed = useMacArgsSchema.parse({ ...base, action: 'run_command', command: 'ls' });
    expect(parsed).toMatchObject({ action: 'run_command', timeout_seconds: 120 });
  });

  it('tells the model which action needs which field', () => {
    const root = toolParameters(useMacArgsSchema) as { properties: Record<string, { description?: string }> };
    expect(root.properties.action).toBeDefined();
    for (const field of ['command', 'timeout_seconds', 'session_id', 'agent', 'prompt']) expect(root.properties[field]?.description, field).toMatch(/action/);
  });
});
