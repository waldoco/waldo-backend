import { expect, it, vi } from 'vitest';
import { ownerBrowserRuntime } from '../src/channels/owner-browser-runtime';
import type { RunEffectScope } from '../src/channels/run-effect-scope';

const proof = vi.hoisted(() => ({ directory: vi.fn(), gateway: vi.fn(), configuration: vi.fn() }));
vi.mock('../src/identity/common-owner-authority', () => ({ commonOwnerAuthority: () => ({ resolve: proof.directory }) }));
vi.mock('../src/channels/common-public-browser-configuration', () => ({ commonPublicBrowserConfiguration: proof.configuration }));
vi.mock('../src/llm/openai', () => ({ OpenAIResponsesAdapter: class { constructor() { proof.gateway(); } complete = vi.fn(); } }));

function fixture() {
  proof.directory.mockReset().mockRejectedValue(Error('Browser-off fixture forbids directory I/O'));
  proof.gateway.mockReset(); proof.configuration.mockReset().mockReturnValue(undefined);
  const rows = new Map<string, unknown>([['do_name', 'browser-off-owner'], ['telegram_subject', '81102']]);
  const put = vi.fn(), alarm = vi.fn(), transaction = vi.fn();
  const storage = { kv: { get: (key: string) => rows.get(key), put, list: () => [] },
    transactionSync: transaction, getAlarm: alarm, setAlarm: alarm, deleteAlarm: alarm } as unknown as DurableObjectStorage;
  const scope: RunEffectScope = { runId: 'ordinary-first-turn', attempt: 'first', deadline: Date.now() + 60000,
    signal: new AbortController().signal, admit: vi.fn(), commit: work => work() };
  const env = { WALDO_ENVIRONMENT: 'staging', OPENAI_API_KEY: 'synthetic',
    TELEGRAM_OWNER_DO: { idFromName: () => ({ toString: () => 'browser-off-physical' }) } } as never;
  const runtime = ownerBrowserRuntime({ env, storage, actualDoId: 'browser-off-physical', activeScope: () => scope });
  const ctx = { authenticatedUserId: 'browser-off-owner', runScope: scope } as never;
  return { runtime, scope, ctx, rows, put, alarm, transaction };
}

it('browser-off first-turn construction and finish add no asynchronous browser work or durable writes', async () => {
  const f = fixture(), network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No external I/O allowed'));
  try {
    expect(f.runtime.attachments(f.scope)).toEqual([]);
    await f.runtime.finish(f.scope);
    await Promise.resolve();
    expect(proof.directory).not.toHaveBeenCalled(); expect(proof.configuration).not.toHaveBeenCalled();
    expect(proof.gateway).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
    expect(f.put).not.toHaveBeenCalled(); expect(f.alarm).not.toHaveBeenCalled(); expect(f.transaction).not.toHaveBeenCalled();
    expect([...f.rows.keys()]).toEqual(['do_name', 'telegram_subject']);
  } finally { network.mockRestore(); }
});

it('browser-off ordinary gateway selection adds no extra model adapter', () => {
  const f = fixture();
  expect(f.runtime.gateway()).toBeUndefined();
  expect(proof.gateway).not.toHaveBeenCalled();
  expect(proof.directory).not.toHaveBeenCalled(); expect(f.put).not.toHaveBeenCalled(); expect(f.alarm).not.toHaveBeenCalled();
});

it('browser-off routing refuses explicit Cloudflare while keeping explicit legacy selection available', async () => {
  const f = fixture(), handle = vi.fn(async () => ({ ok: true as const, data: { selected: 'legacy' }, source_taint: 'external' as const }));
  const handler = f.runtime.read({ name: 'browse_page', handle } as never);
  const args = { url: 'https://example.com', instruction: 'Read page' };
  expect(await handler.handle({ ...args, provider: 'cloudflare_playwright' }, f.ctx)).toMatchObject({ ok: false });
  expect(handle).not.toHaveBeenCalled();
  expect(await handler.handle({ ...args, provider: 'browserbase_stagehand_http_v3' }, f.ctx)).toMatchObject({ ok: true });
  expect(handle).toHaveBeenCalledTimes(1);
  expect(proof.directory).not.toHaveBeenCalled(); expect(proof.gateway).not.toHaveBeenCalled();
  expect(f.put).not.toHaveBeenCalled(); expect(f.alarm).not.toHaveBeenCalled(); expect(f.transaction).not.toHaveBeenCalled();
});
