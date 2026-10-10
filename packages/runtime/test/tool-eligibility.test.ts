import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { WALDO_CHAT_MODEL, type ConnectIntent, type LLMToolCall } from '@waldo/contracts';
import { ownerBrowserRuntime } from '../src/channels/owner-browser-runtime';
import { createOwnerResponder } from '../src/channels/owner-turn';
import type { TurnLogEntry } from '../src/channels/owner-turn-types';
import type { LLMGatewayAdapter } from '../src/llm/provider';
import { eligibleHandlers } from '../src/tools/eligibility';
import { browseActHandler, browsePageHandler } from '../src/tools/live/browser';
import { readDriveHandler } from '../src/tools/live/drive';
import { connectServiceHandler, googleHandlers, type GoogleAccess } from '../src/tools/live/google';
import { callMcpToolHandler, readMcpToolHandler } from '../src/tools/live/mcp';

type Account = Readonly<{ id: string; email: string; error: string | null; calendar: boolean; mail: boolean; tasks: boolean }>;
const clock = { timezone: 'UTC', now: () => new Date('2026-10-10T09:00:00Z') };
const desk = { propose: async () => 'proposal', proposeSendEmail: async () => 'proposal', record: () => undefined };
const CALENDAR = ['propose_calendar_change', 'query_availability', 'query_calendar'];
const MAIL = ['draft_email', 'get_communication', 'read_thread', 'search_communication', 'send_email'];
const account = (features: Partial<Account> = {}): Account => ({ id: 'acct-1', email: 'owner@example.test', error: null, calendar: true, mail: true, tasks: true, ...features });

const turn = async (name: string, accounts: () => readonly Account[] | Promise<readonly Account[]>, script: (round: number) => readonly LLMToolCall[] | undefined) => {
  const offered: (readonly string[] | undefined)[] = [];
  const systems: string[] = [];
  const offers: ConnectIntent[] = [];
  const logs: TurnLogEntry[] = [];
  const google: GoogleAccess = { client: async () => null, state: async () => accounts() };
  const gateway: LLMGatewayAdapter = { complete: async ({ request }) => {
    const calls = script(offered.length);
    offered.push(request.tools?.map(tool => tool.name));
    systems.push(request.system ?? '');
    return { ok: true, data: { model: request.model, text: calls ? '' : 'Done.', ...(calls ? { tool_calls: [...calls] } : {}), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 1 } };
  } };
  await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name)), async () => {
    const args: Parameters<typeof createOwnerResponder> = ['fixture'];
    args[3] = entry => { logs.push(entry); }; args[4] = clock;
    args[5] = [...googleHandlers(google, desk, clock), connectServiceHandler(google)] as never;
    args[6] = WALDO_CHAT_MODEL; args[9] = async intent => { offers.push(intent); return true; }; args[10] = gateway;
    await createOwnerResponder(...args).respond({ traceId: `${name}-1`, conversationRef: 'telegram-42', surface: 'telegram', text: 'what is on my calendar today?', memoryWrites: false }, (_hop, work) => work());
  });
  return { offered, systems, offers, logs };
};
const call = (name: string, args: object): LLMToolCall => ({ call_id: `call-${name}`, name, arguments: JSON.stringify(args) });

it('no Google connected: calendar and mail tools are left out, connect_service stays and its connect button still reaches the channel', async () => {
  const { offered, systems, offers, logs } = await turn('eligibility-none', () => [], round => round === 0 ? [call('connect_service', { service: 'google' })] : undefined);
  expect(offered[0]).toContain('connect_service');
  for (const name of [...CALENDAR, ...MAIL, 'get_tasks']) expect(offered[0], name).not.toContain(name);
  expect(offers).toEqual([expect.objectContaining({ status: 'auth_required', service: 'google', reason: 'not_connected' })]);
  expect(systems[0]).toContain('Google features not connected for this owner: calendar, mail, tasks.');
  const removal = logs.find(entry => entry.hop === 'tool_eligibility')!;
  expect(removal.detail).toBe('not_connected=9 not_configured=0 check_failed=0');
  const shape = logs.find(entry => entry.hop === 'llm_reply')!.shape!;
  const { skill_procedures: procedures = 0, ...joined } = shape.context!.system_sections!;
  expect(joined.connections).toBeGreaterThan(0);
  expect(Object.values(joined).reduce((sum, bytes) => sum + bytes, 0) + 2 * (Object.values(joined).length - 1) + procedures).toBe(shape.system_bytes);
});

it('a calendar-only grant keeps calendar tools, leaves out mail tools, and connect_service offers the missing mail feature', async () => {
  const { offered, systems, offers } = await turn('eligibility-calendar', () => [account({ mail: false, tasks: false })], round => round === 0 ? [call('connect_service', { service: 'google', feature: 'mail' })] : undefined);
  for (const name of CALENDAR) expect(offered[0], name).toContain(name);
  for (const name of [...MAIL, 'get_tasks']) expect(offered[0], name).not.toContain(name);
  expect(systems[0]).toContain('Google features not connected for this owner: mail, tasks.');
  expect(offers).toEqual([{ status: 'auth_required', service: 'google', reason: 'scope_missing', feature: 'mail' }]);
});

it('the tool array is computed once per turn: a connection that lands mid-turn does not change later rounds', async () => {
  let reads = 0;
  const { offered } = await turn('eligibility-rounds', () => reads++ === 0 ? [] : [account()], round => round === 0 ? [call('connect_service', { service: 'google' })] : round === 1 ? [call('get_context', {})] : undefined);
  expect(reads).toBeGreaterThanOrEqual(2);
  expect(offered.length).toBe(3);
  expect(offered[0]).not.toContain('query_calendar');
  expect(offered[1]).toEqual(offered[0]);
  expect(offered[2]).toEqual(offered[0]);
});

it('a failing grant keeps its tools so the call can ask for a reconnect, and an unreadable state keeps every tool', async () => {
  const failing = await turn('eligibility-failing', () => [account({ error: 'invalid_grant' })], () => undefined);
  for (const name of [...CALENDAR, ...MAIL, 'get_tasks']) expect(failing.offered[0], name).toContain(name);
  const broken = await turn('eligibility-unreadable', () => Promise.reject(new Error('storage unavailable')), () => undefined);
  for (const name of [...CALENDAR, ...MAIL, 'get_tasks']) expect(broken.offered[0], name).toContain(name);
  expect(broken.logs.find(entry => entry.hop === 'tool_eligibility')!.detail).toBe('not_connected=0 not_configured=0 check_failed=9');
});

it('deploy configuration decides MCP, browse and Drive eligibility', async () => {
  const verdict = async (handler: { eligible?: () => unknown }) => handler.eligible ? await handler.eligible() : { ok: true };
  const readable = JSON.stringify([{ name: 'drive', url: 'https://mcp.example.test', auth: 'google', requires: 'drive', allow_tools: ['search_files'], read_tools: ['search_files'] }]);
  const plain = JSON.stringify([{ name: 'tools', url: 'https://mcp.example.test' }]);
  const missing = { ok: false, reason: 'not_configured' };
  expect(await verdict(callMcpToolHandler(undefined))).toEqual(missing);
  expect(await verdict(callMcpToolHandler(plain))).toEqual({ ok: true });
  expect(await verdict(readMcpToolHandler(readable, undefined, false))).toEqual(missing);
  expect(await verdict(readMcpToolHandler(plain, undefined, true))).toEqual(missing);
  expect(await verdict(readMcpToolHandler(readable, undefined, true))).toEqual({ ok: true });
  expect(await verdict(browsePageHandler(undefined, undefined, undefined))).toEqual(missing);
  expect(await verdict(browsePageHandler('key', 'project', undefined))).toEqual({ ok: true });
  expect(await verdict(browsePageHandler(undefined, undefined, undefined, fetch, { defaultProvider: 'cloudflare_playwright', allowBrowserbase: false, cloudflare: (async () => ({})) as never }))).toEqual({ ok: true });
  expect(await verdict(browsePageHandler('key', 'project', undefined, fetch, { defaultProvider: 'browserbase_stagehand_http_v3', allowBrowserbase: false }))).toEqual(missing);
  expect(await verdict(browseActHandler(undefined, undefined, undefined))).toEqual(missing);
  expect(await verdict(browseActHandler('key', 'project', undefined))).toEqual({ ok: true });
  expect(await verdict(readDriveHandler({ client: async () => null }, false))).toEqual(missing);
  expect(await verdict(readDriveHandler({ client: async () => null }, true))).toEqual({ ok: true });
});

it('the owner browser keeps browse tools where it serves them natively, and otherwise follows the fallback provider', async () => {
  const storage = { kv: { get: () => undefined, put: () => undefined, list: () => [] } } as unknown as DurableObjectStorage;
  const runtime = (environment: string) => ownerBrowserRuntime({ env: { WALDO_ENVIRONMENT: environment } as never, storage, actualDoId: 'physical', activeScope: () => undefined });
  const missing = { ok: false, reason: 'not_configured' };
  expect(await runtime('production').read(browsePageHandler(undefined, undefined, undefined)).eligible!()).toEqual(missing);
  expect(await runtime('production').act(browseActHandler(undefined, undefined, undefined)).eligible!()).toEqual(missing);
  expect(await runtime('production').read(browsePageHandler('key', 'project', undefined)).eligible!()).toEqual({ ok: true });
  expect(await runtime('staging').read(browsePageHandler(undefined, undefined, undefined)).eligible!()).toEqual({ ok: true });
  expect(await runtime('staging').act(browseActHandler(undefined, undefined, undefined)).eligible!()).toEqual({ ok: true });
});

it('the host keeps handlers without a check and handlers whose check throws, and names only connectable features', async () => {
  const handlers = [
    { name: 'connect_service' },
    { name: 'call_mcp_tool', eligible: () => ({ ok: false as const, reason: 'not_configured' as const }) },
    { name: 'get_communication', eligible: async () => ({ ok: false as const, reason: 'not_connected' as const, connect: { status: 'auth_required' as const, service: 'google' as const, reason: 'not_connected' as const, feature: 'mail' as const } }) },
    { name: 'get_tasks', eligible: () => { throw new Error('unreadable'); } },
  ];
  const { handlers: kept, report } = await eligibleHandlers(handlers);
  expect(kept.map(handler => handler.name)).toEqual(['connect_service', 'get_tasks']);
  expect(report).toEqual({ not_connected: 1, not_configured: 1, check_failed: 1, unconnected: ['mail'] });
});
