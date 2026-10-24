import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { OwnerDO } from '../src/channels/owner-do';
import { consoleAccess } from '../src/channels/console';
import { CONTROLS_PATH } from '../src/channels/dashboard-controls';
import { DASHBOARD_OVERVIEW_PATH } from '../src/channels/dashboard-overview';

// A decision waiting in the console carries a review the owner can decide on: the frozen tool, its arguments and what
// approving does. A request no writer can raise any more is not left waiting forever.
type Waiting = { data: { proposals: { id: string; kind: string; state: string; review: Record<string, unknown> | null; actions: string[] }[] } };

const withConsole = (label: string, body: (h: { state: DurableObjectState; read(): Promise<Waiting>; overview(): Promise<{ waiting: { count: number } }> }) => Promise<void>) => {
  const name = `${label}-${crypto.randomUUID()}`, stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name));
  return runInDurableObject(stub, async (_unused, state) => {
    const instance = new OwnerDO(state, { ...env, TELEGRAM_BOT_TOKEN: 'fictional-telegram-token', TELEGRAM_WEBHOOK_SECRET: 'fictional-webhook-secret', OPENAI_API_KEY: 'synthetic-model-key', WALDO_OWNER_TIMEZONE: 'UTC', BROWSER: undefined } as never);
    state.storage.kv.put('do_name', name); state.storage.kv.put('origin', 'https://telegram-owner'); state.storage.kv.put('telegram_subject', '424242');
    const cookie = { cookie: `waldo_console=${await consoleAccess(state.storage).grant()}` };
    (instance as unknown as { setup(channel: string): unknown }).setup('telegram');
    const get = async <T>(path: string) => { const response = await instance.fetch(new Request(`https://telegram-owner${path}`, { headers: cookie })); expect(response.status).toBe(200); return response.json() as Promise<T>; };
    await body({ state, read: () => get<Waiting>(`${CONTROLS_PATH}?view=waiting`), overview: () => get(DASHBOARD_OVERVIEW_PATH) });
  });
};
const insert = (state: DurableObjectState, id: string, kind: string, summary: string, payload: unknown, createdAt = Date.now() - 60_000) =>
  state.storage.sql.exec("INSERT INTO ledger (id, kind, status, summary, payload_json, created_at) VALUES (?, ?, 'open', ?, ?, ?)", id, kind, summary, JSON.stringify(payload), createdAt);

it('a waiting MCP tool call shows the frozen tool, its arguments and what approving does', async () => {
  await withConsole('waiting-review-mcp', async ({ state, read }) => {
    insert(state, 'p-mcp-review', 'mcp_call', 'Run this MCP tool?', { server: 'calendar', tool: 'list_events', args: { day: 'SYNTHETIC-DAY' } });
    const item = (await read()).data.proposals.find(proposal => proposal.id === 'p-mcp-review')!;
    expect(item.review).not.toBeNull();
    expect(item.review!.kind).toBe('mcp_call');
    expect(item.review!.text).toContain('Run this MCP tool? Run list_events on the calendar MCP server');
    expect(item.review!.text).toContain('SYNTHETIC-DAY');
  });
});

it('a waiting action raised from outside content shows its tool, its arguments and why it needs approval', async () => {
  await withConsole('waiting-review-tainted', async ({ state, read }) => {
    insert(state, 'p-taint-review', 'tainted_action', 'Run this action?', { tool: 'set_reminder', args: { note: 'SYNTHETIC-NOTE from a page' }, reasoning: 'The page asked for a reminder' });
    const item = (await read()).data.proposals.find(proposal => proposal.id === 'p-taint-review')!;
    expect(item.review).toMatchObject({ kind: 'tainted_action' });
    expect(item.review!.text).toContain('Tool: set_reminder');
    expect(item.review!.text).toContain('SYNTHETIC-NOTE from a page');
    expect(item.review!.text).toContain('It uses content from an email or web page, so it needs your approval before it runs.');
  });
});

it('a task-source request left from the removed classifier expires instead of waiting forever, and its row is kept', async () => {
  await withConsole('waiting-review-task-sources', async ({ state, read, overview }) => {
    insert(state, 'p-legacy-sources', 'task_sources', 'Start a new task with read access only to: mcp',
      { ownerKey: 'owner', taskId: 't1', revision: 1, nonce: 'n1', action: 'new', sources: ['mcp'], expiresAt: Date.now() - 16 * 86_400_000 }, Date.now() - 16 * 86_400_000);
    expect((await read()).data.proposals.filter(proposal => proposal.state === 'open')).toEqual([]);
    expect((await overview()).waiting.count).toBe(0);
    expect(state.storage.sql.exec<{ status: string }>("SELECT status FROM ledger WHERE id = 'p-legacy-sources'").one().status).toBe('expired');
  });
});
