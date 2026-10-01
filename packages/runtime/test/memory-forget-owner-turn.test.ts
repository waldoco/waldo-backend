import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';

const seen = vi.hoisted(() => ({ writerOps: [] as string[], replyInputs: [] as string[], writerInputs: [] as string[] }));
vi.mock('openai', () => ({ default: class { responses = { create: async (body: unknown) => {
  const b = body as { text?: { format?: { type: string } } };
  const writer = b.text?.format?.type === 'json_schema';
  if (writer) seen.writerInputs.push(JSON.stringify(body)); else seen.replyInputs.push(JSON.stringify(body));
  return { id: 'fixture', output_text: writer ? seen.writerOps.shift() ?? '{}' : 'pong', output: [], usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } };
} }; } }));
const { createOwnerResponder } = await import('../src/channels/owner-turn');
const { claimStore } = await import('../src/memory/claims');

const PREF = 'five-minute easy stretch before focus block';
const ops = (o: Record<string, unknown>) => JSON.stringify({ add: [], corrections: [], seen: [], confirm: [], dismiss: [], forget_claims: [], forget_nodes: [], forget_topic: null, ...o });

// Layer: owner-turn fixture (real claimStore in the owner DO, mocked provider, scripted writer).
// The reply must be told what the memory writer did this turn, from code, so it can neither claim a
// save nor deny a forget it has no receipt for. Not covered: a live writer or staging.
const system = (): string => (JSON.parse(seen.replyInputs.at(-1)!) as { instructions: string }).instructions;
type Redact = (texts: readonly string[]) => Promise<{ rewritten: number; remaining: number }>;
const session = async (name: string, work: (turn: (id: string, text: string, writer: string) => Promise<void>, store: ReturnType<typeof claimStore>, responder: ReturnType<typeof createOwnerResponder>) => Promise<void>, redact?: Redact) => {
  await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name)), async (_i, state) => {
    const store = claimStore(state.storage.sql);
    const responder = createOwnerResponder('fixture', undefined, store as never, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, redact);
    await work(async (id, text, writer) => { seen.writerOps.push(writer); await responder.respond({ traceId: id, conversationRef: 'owner', surface: 'telegram', text }, (_n, w) => w()); }, store, responder);
  });
};
const add = (text: string, evidence: string) => ops({ add: [{ kind: 'preference', text, source: 'stated', evidence, touches_forgotten: false }] });
const receiptOf = (sys: string): string => sys.slice(sys.indexOf('Memory this turn'), sys.indexOf('Memory this turn') + 400);

it('the reply is told a claim was stored, and what a forget removed', async () => {
  await session('forget-live-a', async (turn, store) => {
    await turn('tg-1', `Test preference: a ${PREF}. Just a demo.`, add(`Prefers a ${PREF}`, `owner, tg-1: "${PREF}"`));
    expect(store.claims().length).toBe(1);
    expect(system()).toContain('Memory this turn');
    expect(receiptOf(system())).toContain('stored 1 new claim');
    await turn('tg-2', 'forget only that pref', ops({ forget_claims: [1], forget_topic: 'five-minute stretch' }));
    expect(store.claims().length).toBe(0);
    expect(receiptOf(system())).toContain('removed 1 claim from stored memory');
    expect(receiptOf(system())).not.toContain('stored 1');
  });
});

it('when the owner asks to forget and the writer forgot nothing, the reply is told nothing was forgotten', async () => {
  await session('forget-live-b', async (turn, store) => {
    await turn('tg-1', `Test preference: a ${PREF}. Just a demo.`, add(`Prefers a ${PREF}`, `owner, tg-1: "${PREF}"`));
    await turn('tg-2', 'forget only that pref', ops({}));
    expect(store.claims().length).toBe(1);
    expect(receiptOf(system())).toContain('nothing was forgotten');
  });
});

it('a held claim is reported as held, not stored', async () => {
  await session('forget-live-c', async (turn, store) => {
    await turn('tg-1', 'please check my mail today', add('Check my mail today', 'owner, tg-1: "please check my mail today"'));
    expect(store.claims().length).toBe(0);
    expect(receiptOf(system())).toContain('held 1');
    expect(receiptOf(system())).toContain('stored 0');
  });
});

it('a turn where the writer changed nothing carries no memory receipt', async () => {
  await session('forget-live-d', async (turn) => {
    await turn('tg-1', 'hello', ops({}));
    expect(system()).not.toContain('Memory this turn');
  });
});

it('a claim whose quote the owner never said is reported as kept only as inferred', async () => {
  await session('forget-live-e', async (turn, store) => {
    await turn('tg-1', `Test preference: a ${PREF}. Just a demo.`, add(`Prefers a ${PREF}`, 'owner, tg-1: "I like a short warm-up before deep work"'));
    expect(store.claims().map((c) => c.source)).toEqual(['inferred']);
    expect(receiptOf(system())).toContain('stored 1 new claim (1 kept only as inferred');
  });
});

const saved = (turn: (id: string, text: string, writer: string) => Promise<void>) => turn('tg-1', `Test preference: a ${PREF}.`, add(`Prefers a ${PREF}`, `owner, tg-1: "${PREF}"`));

it('a machine turn on the same responder after an owner save does not inherit the receipt', async () => {
  await session('forget-live-f', async (turn, _store, responder) => {
    await saved(turn);
    expect(system()).toContain('Memory this turn');
    await responder.prompt('sys-1', 'owner', 'scheduled check', (_n, w) => w(), 'telegram');
    expect(system()).not.toContain('Memory this turn');
    await saved(turn);
    await responder.remind('sys-2', 'owner', 'stretch', (_n, w) => w(), 'telegram');
    expect(system()).not.toContain('Memory this turn');
  });
});

it('a repeated forget id counts one removal, and an unknown id counts none', async () => {
  await session('forget-live-g', async (turn) => {
    await saved(turn);
    await turn('tg-2', 'forget only that pref', ops({ forget_claims: [1, 1] }));
    expect(receiptOf(system())).toContain('removed 1 claim from stored memory');
    expect(receiptOf(system())).not.toContain('removed 2');
  });
  await session('forget-live-h', async (turn, store) => {
    await saved(turn);
    await turn('tg-2', 'forget only that pref', ops({ forget_claims: [999] }));
    expect(store.claims().length).toBe(1);
    expect(receiptOf(system())).toContain('nothing was forgotten');
  });
});

it('corrections, confirmations and dismissals are listed, each unique id once', async () => {
  await session('forget-live-i', async (turn) => {
    await saved(turn);
    await turn('tg-2', 'yes that is right', ops({ confirm: [1, 1] }));
    expect(receiptOf(system())).toContain('confirmed 1 claim');
    await turn('tg-3', 'never mind that one', ops({ dismiss: [1, 1] }));
    expect(receiptOf(system())).toContain('dismissed 1 claim');
  });
});

it('a conversation redaction that leaves entries behind is stated, not reported as clean', async () => {
  await session('forget-live-j', async (turn) => {
    await saved(turn);
    await turn('tg-2', 'forget only that pref', ops({ forget_claims: [1] }));
    expect(receiptOf(system())).not.toContain('still contain');
  }, async () => ({ rewritten: 1, remaining: 0 }));
  await session('forget-live-k', async (turn) => {
    await saved(turn);
    await turn('tg-2', 'forget only that pref', ops({ forget_claims: [1] }));
    expect(receiptOf(system())).toContain('2 saved conversation entries still contain it');
  }, async () => ({ rewritten: 0, remaining: 2 }));
});

it('a failure after the writer applied ops yields the uncertain notice and no success receipt', async () => {
  await session('forget-live-l', async (turn) => {
    await saved(turn);
    await turn('tg-2', 'forget only that pref', ops({ forget_claims: [1] }));
    const sys = system();
    expect(sys).toContain('only partly stored');
    expect(sys).not.toContain('Memory this turn');
  }, async () => { throw new Error('kv down'); });
});
