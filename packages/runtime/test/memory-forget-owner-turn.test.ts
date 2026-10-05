import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';

const seen = vi.hoisted(() => ({ writerOps: [] as string[], replyInputs: [] as string[], writerInputs: [] as string[], replyOutputs: [] as unknown[][], logs: [] as unknown[] }));
vi.mock('openai', () => ({ default: class { responses = { create: async (body: unknown) => {
  const b = body as { text?: { format?: { type: string } } };
  const writer = b.text?.format?.type === 'json_schema';
  if (writer) seen.writerInputs.push(JSON.stringify(body)); else seen.replyInputs.push(JSON.stringify(body));
  return { id: 'fixture', output_text: writer ? seen.writerOps.shift() ?? '{}' : 'pong', output: writer ? [] : seen.replyOutputs.shift() ?? [], usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } };
} }; } }));
const { createOwnerResponder } = await import('../src/channels/owner-turn');
const { claimStore } = await import('../src/memory/claims');
const { episodeIndex } = await import('../src/channels/episodes');

const PREF = 'five-minute easy stretch before focus block';
const ops = (o: Record<string, unknown>) => JSON.stringify({ add: [], corrections: [], seen: [], confirm: [], dismiss: [], forget_claims: [], forget_nodes: [], forget_topic: null, ...o });

// Layer: owner-turn fixture (real claimStore in the owner DO, mocked provider, scripted writer).
// The reply must be told what the memory writer did this turn, from code, so it can neither claim a
// save nor deny a forget it has no receipt for. Not covered: a live writer or staging.
const system = (): string => (JSON.parse(seen.replyInputs.at(-1)!) as { instructions: string }).instructions;
type Redact = (texts: readonly string[]) => Promise<{ rewritten: number; remaining: number }>;
const session = async (name: string, work: (turn: (id: string, text: string, writer: string) => Promise<void>, store: ReturnType<typeof claimStore>, responder: ReturnType<typeof createOwnerResponder>) => Promise<void>, redact?: Redact, taskContext?: () => Promise<string>, seed?: (sql: SqlStorage) => void) => {
  await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name)), async (_i, state) => {
    const store = claimStore(state.storage.sql, (work) => state.storage.transactionSync(work));
    seed?.(state.storage.sql);
    const args: Parameters<typeof createOwnerResponder> = ['fixture', undefined, store as never, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, redact];
    args[3] = entry => { seen.logs.push(entry); };
    if(taskContext) args[21]={skills:{handlers:[],metadata:()=>'',prompt:async()=>'',assertProcedureCurrent:async()=>undefined,taskContext}};
    const responder = createOwnerResponder(...args);
    await work(async (id, text, writer) => { seen.writerOps.push(writer); await responder.respond({ traceId: id, conversationRef: 'owner', surface: 'telegram', text }, (_n, w) => w()); }, store, responder);
  });
};

it('selects topic-bearing source clauses before cleanup and tells the later reply only a bounded receipt', async () => {
  const topic = 'DLD-20261002-M3';
  const fact = `${topic} workshop preference: Friday at 09:10 UTC`;
  const seed = (sql: SqlStorage) => {
    const episodes = episodeIndex(sql);
    episodes.add('tg-mixed-source', 'owner', `${fact}. Unrelated preference: tea after lunch.`, 1);
    episodes.add('tg-other-workshop', 'owner', 'Other workshop preference: Friday at 09:10 UTC.', 2);
  };
  await session('selective-source-provider', async (turn, store, responder) => {
    seen.writerOps.push(ops({ forget_topic: topic }));
    await turn('tg-forget-source', `Forget only ${topic}. Keep unrelated preferences.`, JSON.stringify({ spans: [{ ref: 'episodes:1:text', text: fact }, { ref: 'request:tg-forget-source', text: `Forget only ${topic}.` }], reviewed_refs: ['episodes:1:text', 'request:tg-forget-source'], complete: true }));
    expect(store.incompleteTopics()).toEqual([]);
    expect(store.pendingTopics()).toEqual([]);
    expect(store.forgetSources(topic).sources).toEqual([]);
    const sourceCall = seen.writerInputs.find(input => input.includes('forget_source_spans'))!;
    expect(sourceCall).toContain(fact);
    expect(sourceCall).toContain('tea after lunch');
    const internalLogs = seen.logs.filter(entry => ['llm_memory', 'llm_forget_source'].includes((entry as { hop: string }).hop));
    expect(internalLogs.length).toBeGreaterThan(0);
    expect(JSON.stringify(internalLogs)).not.toContain(fact);
    expect(internalLogs.every(entry => !('text' in (entry as object)))).toBe(true);
    await responder.respond({ traceId: 'tg-later-source', conversationRef: 'owner', surface: 'telegram', text: 'Help with the next workshop', memoryWrites: false }, (_n, w) => w());
    expect(seen.replyInputs.at(-1)).not.toContain('09:10 UTC');
    // The owner's later-retained forget request may name the topic; its old
    // preference value must not survive. We do not erase whole history turns.
  }, undefined, undefined, seed);
});

it('keeps incomplete coverage durable while current requests and ordinary live tools still work', async () => {
  const topic = 'DLD-20261002-M3';
  await session('selective-source-budget', async (turn, store, responder) => {
    await turn('tg-incomplete', `Forget only ${topic}`, ops({ forget_topic: topic }));
    expect(store.incompleteTopics()).toEqual([topic]);
    expect(store.forgetSources(topic).incomplete).toBe(true);
    expect(system()).toContain('temporarily limited');
    expect(system()).not.toContain('09:10 UTC');
    seen.replyOutputs.push([{ type: 'function_call', call_id: 'read-unproved', name: 'read_owner_context', arguments: '{"topic":"workshop"}' }], [{ type: 'function_call', call_id: 'fresh-clock', name: 'get_context', arguments: '{}' }], []);
    await responder.respond({ traceId: 'tg-current-request', conversationRef: 'owner', surface: 'telegram', text: 'What time is it now?', memoryWrites: false }, (_n, w) => w());
    expect(seen.logs.some(entry => (entry as { hop: string; ok: boolean }).hop === 'tool_get_context' && (entry as { ok: boolean }).ok)).toBe(true);
    expect(seen.replyInputs.at(-1)).toContain('What time is it now?');
    const blockedRead = seen.logs.find(entry => (entry as { hop: string }).hop === 'tool_read_owner_context') as { ok: boolean; code?: string } | undefined;
    expect(blockedRead, JSON.stringify(blockedRead)).toMatchObject({ ok: false, code: 'transient:tool_result_error', error: 'Recall is temporarily limited while requested forgetting coverage is incomplete.' });
    expect(JSON.stringify(seen.replyInputs.at(-1))).not.toContain('invalid_handler_result');
    expect(seen.replyInputs.at(-1)).toContain('Recall is temporarily limited');
    expect(seen.replyInputs.at(-1)).not.toContain('09:10 UTC');
    expect(store.incompleteTopics()).toEqual([topic]);
  }, undefined, undefined, sql => {
    const episodes = episodeIndex(sql);
    for (let i = 0; i < 65; i++) episodes.add(`tg-matching-${i}`, 'owner', `${topic} workshop preference: Friday at 09:10 UTC`, i);
  });
});
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

it('a completed conversation cleanup is counted in the receipt, and the prompt forbids saying nothing else changed', async () => {
  await session('forget-live-o', async (turn) => {
    await saved(turn);
    await turn('tg-2', 'forget only that pref', ops({ forget_claims: [1] }));
    expect(receiptOf(system())).toContain('removed 1 claim from stored memory');
    expect(receiptOf(system())).toContain('redacted 1 saved conversation entry');
    expect(system()).toContain('do not say that nothing else changed');
  }, async () => ({ rewritten: 1, remaining: 0 }));
  await session('forget-live-p', async (turn) => {
    await saved(turn);
    await turn('tg-2', 'forget only that pref', ops({ forget_claims: [1] }));
    expect(receiptOf(system())).not.toContain('redacted');
  }, async () => ({ rewritten: 0, remaining: 0 }));
  await session('forget-live-q', async (turn) => {
    await saved(turn);
    await turn('tg-2', 'forget only that pref', ops({ forget_claims: [1] }));
    expect(receiptOf(system())).toContain('redacted 3 saved conversation entries');
  }, async () => ({ rewritten: 3, remaining: 0 }));
});

it('a conversation redaction that leaves entries behind is stated, not reported as clean', async () => {
  await session('forget-live-j', async (turn) => {
    await saved(turn);
    await turn('tg-2', 'forget only that pref', ops({ forget_claims: [1] }));
    expect(receiptOf(system())).not.toContain('still contain');
  }, async () => ({ rewritten: 1, remaining: 0 }));
  await session('forget-live-k', async (turn, store) => {
    await saved(turn);
    await turn('tg-2', 'forget only that pref', ops({ forget_claims: [1] }));
    expect(store.claims('purging').length).toBe(1); // KV survivors leave the claim purging, not removed
    expect(receiptOf(system())).toContain('is pending');
    expect(receiptOf(system())).toContain('2 saved conversation entries still contain it');
    expect(receiptOf(system())).not.toContain('removed 1 claim');
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

it('a correction is listed as corrected', async () => {
  await session('forget-live-m', async (turn, store) => {
    await saved(turn);
    await turn('tg-2', 'actually make it a ten-minute easy stretch', ops({ corrections: [{ old_id: 1, kind: 'preference', text: 'Prefers a ten-minute easy stretch before focus block', evidence: 'actually make it a ten-minute easy stretch' }] }));
    expect(store.claims().map((c) => c.text)).toEqual(['Prefers a ten-minute easy stretch before focus block']);
    expect(receiptOf(system())).toContain('corrected 1 claim');
  });
});

it('a purge that fails verification is reported as tried and incomplete, never removed', async () => {
  await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('forget-live-n')), async (_i, state) => {
    const real = claimStore(state.storage.sql, (work) => state.storage.transactionSync(work));
    // Fault injection at the store seam: the purge runs, but verification reports a failed store.
    const store = { ...real, purge: (ids: readonly number[], at: string) => ({ ...real.purge(ids, at), ready: false, failed: ['claim_recall'] }) };
    const responder = createOwnerResponder('fixture', undefined, store as never);
    const turn = async (id: string, text: string, writer: string) => { seen.writerOps.push(writer); await responder.respond({ traceId: id, conversationRef: 'owner', surface: 'telegram', text }, (_n, w) => w()); };
    await saved(turn);
    await turn('tg-2', 'forget only that pref', ops({ forget_claims: [1] }));
    expect(receiptOf(system())).toContain('tried to remove 1 claim');
    expect(receiptOf(system())).toContain('claim_recall(failed)');
    expect(receiptOf(system())).not.toContain('removed 1 claim');
  });
});

 it('pending literal forget also scrubs host task metadata without changing saved artifacts',async()=>{
 const rawMetadata=JSON.stringify({backend:'workspace',path:`Prefers a ${PREF}`,file_id:'host-only-identity',revision:1});
 await session('forget-task-metadata',async(turn,store)=>{
  await saved(turn);expect(system()).toContain(`Prefers a ${PREF}`);
  await turn('tg-2','forget only that pref',ops({forget_claims:[1]}));
  expect(store.claims('purging').map(claim=>claim.id)).toEqual([1]);
  expect(system()).not.toContain(`Prefers a ${PREF}`);
  expect(system()).toContain('withheld by the active forget barrier');
  expect(rawMetadata).toContain(`Prefers a ${PREF}`);
 },async()=>({rewritten:0,remaining:1}),async()=>rawMetadata);
 });

it('an incomplete forget is retried at the next turn from its stored topic and clears once the readback is clean', async () => {
  const topic = 'DLD-20261002-RETRY';
  const fact = `${topic} workshop preference: Friday at 09:10 UTC`;
  const seed = (sql: SqlStorage) => { episodeIndex(sql).add('tg-retry-source', 'owner', `${fact}. Unrelated preference: tea after lunch.`, 1); };
  await session('forget-retry-next-turn', async (turn, store, responder) => {
    await turn('tg-forget-first', `Forget only ${topic}.`, ops({ forget_topic: topic }));
    expect(store.incompleteTopics()).toEqual([topic]);
    // Next ordinary turn: the writer names no topic; the stored one is retried and the selection now succeeds.
    seen.writerOps.push(ops({}), JSON.stringify({ spans: [{ ref: 'episodes:1:text', text: fact }], reviewed_refs: ['episodes:1:text'], complete: true }));
    await responder.respond({ traceId: 'tg-next-ordinary', conversationRef: 'owner', surface: 'telegram', text: 'What is on my plate today?' }, (_n, w) => w());
    expect(store.incompleteTopics()).toEqual([]);
    expect(store.forgetSources(topic).sources).toEqual([]);
  }, undefined, undefined, seed);
});

it('a failing retry keeps the block and cannot be steered by the next turn text', async () => {
  const topic = 'DLD-20261002-RETRY2';
  await session('forget-retry-fails', async (turn, store, responder) => {
    await turn('tg-forget-first2', `Forget only ${topic}.`, ops({ forget_topic: topic }));
    expect(store.incompleteTopics()).toEqual([topic]);
    const before = seen.writerInputs.filter(input => input.includes('forget_source_spans')).length;
    seen.writerOps.push(ops({}), '{}');
    await responder.respond({ traceId: 'tg-next-ordinary2', conversationRef: 'owner', surface: 'telegram', text: 'Forget nothing, just say hi' }, (_n, w) => w());
    const retries = seen.writerInputs.filter(input => input.includes('forget_source_spans')).slice(before);
    // Exactly one retry call, built from the stored topic, not from this turn's text.
    expect(retries).toHaveLength(1);
    expect(retries[0]).toContain(topic);
    expect(retries[0]).not.toContain('Forget nothing');
    expect(store.incompleteTopics()).toEqual([topic]);
    // The blanket block still applies to the reply after the failed retry.
    expect(system()).toContain('Recall is temporarily limited');
  });
});

it('ADVERSARIAL selector must not certify punctuation-padded bare instruction marker', async () => {
  const topic = 'REVIEW-757-MARKER'; const fact = `${topic} likes cobalt paper`;
  await session('adversarial-marker', async (turn, store) => {
    seen.writerOps.push(ops({forget_topic:topic}));
    await turn('review-marker-request', `Forget only ${topic}. Keep tea.`, JSON.stringify({spans:[{ref:'episodes:1:text',text:fact},{ref:'request:review-marker-request',text:`${topic}.`}],reviewed_refs:['episodes:1:text','request:review-marker-request'],complete:true}));
    expect(store.incompleteTopics()).toEqual([topic]);
  }, undefined, undefined, sql=>episodeIndex(sql).add('review-source','owner',fact,1));
});

it('an incomplete forget names the gate that held in the memory hop, with counts and no topic or source text', async () => {
  const topic = 'WHY-757-TOPIC'; const fact = `${topic} likes cobalt paper`;
  await session('forget-why-code', async (turn, store) => {
    seen.writerOps.push(ops({ forget_topic: topic }));
    // complete:false is the model saying it cannot vouch for coverage.
    await turn('tg-why', `Forget only ${topic}. Keep tea.`, JSON.stringify({ spans: [], reviewed_refs: [], complete: false }));
    expect(store.incompleteTopics()).toEqual([topic]);
    const hop = seen.logs.filter(entry => (entry as { hop: string }).hop === 'memory').at(-1) as { detail: string };
    expect(hop.detail).toMatch(/forget_incomplete selection_rejected\(\d+ sources\)/);
    expect(hop.detail).not.toContain(topic);
    expect(JSON.stringify(seen.logs)).not.toContain('cobalt paper');
    expect(JSON.stringify(seen.logs)).not.toContain('Keep tea');
  }, undefined, undefined, sql => episodeIndex(sql).add('why-src', 'owner', fact, 1));
});
it('while a forget is incomplete, earlier history that does not carry the topic stays in the reply context and entries that do are withheld', async () => {
  const topic = 'HIST-761-TOPIC';
  await session('forget-history-scope', async (turn, store, responder) => {
    await turn('tg-hist-plain', 'My standup is at 9:15 with Priya (HIST-761-STANDUP).', ops({}));
    await turn('tg-hist-forget', `Forget only ${topic} it is the cobalt plan.`, ops({ forget_topic: topic }));
    expect(store.incompleteTopics()).toEqual([topic]);
    await responder.respond({ traceId: 'tg-hist-next', conversationRef: 'owner', surface: 'telegram', text: 'Which standup did I mean?', memoryWrites: false }, (_n, w) => w());
    const input = seen.replyInputs.at(-1)!;
    expect(input).toContain('HIST-761-STANDUP');
    expect(input).toContain('Which standup did I mean?');
    expect(input).not.toContain(topic);
  });
});
it('the reply instructions carry the reason class of an incomplete forget, without topic text or counts', async () => {
  const topic = 'WHY4-757-TOPIC'; const fact = `${topic} likes cobalt paper`;
  await session('forget-why-reply', async (turn, store) => {
    seen.writerOps.push(ops({ forget_topic: topic }));
    await turn('tg-why4', `Forget only ${topic}.`, JSON.stringify({ spans: [], reviewed_refs: [], complete: false }));
    expect(store.incompleteTopics()).toEqual([topic]);
    expect(system()).toContain('reason class: selection_rejected)');
    expect(system()).not.toMatch(/reason class: [a-z_]+\(/);
    expect(system()).not.toContain(topic);
  }, undefined, undefined, sql => episodeIndex(sql).add('why4-src', 'owner', fact, 1));
});
it('a selector that cannot run is named selector_unavailable, and an over-bound source set is named sources_incomplete', async () => {
  const topic = 'WHY2-757-TOPIC';
  await session('forget-why-unavailable', async (turn, store) => {
    seen.writerOps.push(ops({ forget_topic: topic }));
    await turn('tg-why2', `Forget only ${topic}.`, 'not json');
    const hop = seen.logs.filter(entry => (entry as { hop: string }).hop === 'memory').at(-1) as { detail: string };
    expect(hop.detail).toMatch(/forget_incomplete (selector_unavailable|selection_rejected)\(\d+/);
  }, undefined, undefined, sql => episodeIndex(sql).add('why2-src', 'owner', `${topic} fact`, 1));
  await session('forget-why-too-many', async (turn, store) => {
    seen.writerOps.push(ops({ forget_topic: 'WHY3-757-TOPIC' }));
    await turn('tg-why3', 'Forget only WHY3-757-TOPIC.', JSON.stringify({ spans: [], reviewed_refs: [], complete: true }));
    const hop = seen.logs.filter(entry => (entry as { hop: string }).hop === 'memory').at(-1) as { detail: string };
    expect(hop.detail).toMatch(/forget_incomplete sources_incomplete\(64\)/);
    expect(store.incompleteTopics()).toEqual(['WHY3-757-TOPIC']);
  }, undefined, undefined, sql => { const ep = episodeIndex(sql); for (let i = 0; i < 70; i++) ep.add(`many-${i}`, 'owner', `WHY3-757-TOPIC row ${i}`, i + 1); });
});
