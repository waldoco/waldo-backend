import { describe, expect, it } from 'vitest';
import { connectAppArgsSchema, connectAppResultSchema } from './connect-app';

describe('connect_app arguments', () => {
  it.each([
    [{ connector_id: 'notion' }],
    [{ connector_id: 'linear', method: 'link' }],
    [{ connector_id: 'wispr', method: 'code' }],
    [{ connector_id: 'google-drive-2' }],
  ])('accepts a catalogue-shaped id %j', (args) => {
    expect(connectAppArgsSchema.safeParse(args).success).toBe(true);
  });

  it.each([
    ['no id', {}],
    ['an empty id', { connector_id: '' }],
    ['an address in place of an id', { connector_id: 'https://mcp.notion.com/mcp' }],
    ['a host in place of an id', { connector_id: 'mcp.notion.com' }],
    ['an uppercase id', { connector_id: 'Notion' }],
    ['an id with a space', { connector_id: 'not ion' }],
    ['a one-letter id', { connector_id: 'n' }],
    ['an over-long id', { connector_id: `a${'b'.repeat(32)}` }],
    ['a free-form url argument', { connector_id: 'notion', url: 'https://evil.example/authorize' }],
    ['a chosen destination', { connector_id: 'notion', chat_id: 7 }],
    ['an unknown method', { connector_id: 'notion', method: 'password' }],
    ['a non-string id', { connector_id: 42 }],
  ])('refuses %s', (_label, args) => {
    expect(connectAppArgsSchema.safeParse(args).success).toBe(false);
  });
});

describe('connect_app result', () => {
  it.each([
    [{ status: 'sent', method: 'link', surface: 'imessage' }],
    [{ status: 'sent', method: 'code', surface: 'app' }],
    [{ status: 'already_connected' }],
    [{ status: 'not_sent', reason: 'unknown_app' }],
    [{ status: 'not_sent', reason: 'code_unavailable' }],
    [{ status: 'not_sent', reason: 'sign_in_failed' }],
  ])('accepts %j', (result) => {
    expect(connectAppResultSchema.safeParse(result).success).toBe(true);
  });

  it.each([
    ['a link in the result', { status: 'sent', method: 'link', surface: 'app', link: 'https://waldo.invalid/c/abc' }],
    ['a code in the result', { status: 'sent', method: 'code', surface: 'app', user_code: 'ABCD-EFGH' }],
    ['an unknown surface', { status: 'sent', method: 'link', surface: 'email' }],
    ['an unknown reason', { status: 'not_sent', reason: 'because' }],
    ['a sent result without its method', { status: 'sent', surface: 'app' }],
  ])('refuses %s', (_label, result) => {
    expect(connectAppResultSchema.safeParse(result).success).toBe(false);
  });
});
