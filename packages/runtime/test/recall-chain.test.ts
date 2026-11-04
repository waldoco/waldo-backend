// The recall chain on real Durable Object SQLite: every row a recall read returns names the rows next to it, by refs the
// existing reads take, so the model can follow a thread hop by hop. Each link is made by the writer that runs in
// production (the episode index, remember, the run book, the job book); a card's payload is the approval desk's shape.
// Falsifiers: a link to a row that does not exist, a link the switch-off reads would show, a link line that keeps a topic
// being forgotten or a health number, and a link that survives its row's purge. Every row is synthetic.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import type { RecallLink, SearchHistoryResult } from '@waldo/contracts';
import { describe, expect, it } from 'vitest';
import { approvalDesk, ledgerSummary, type EmailSendProposal } from '../src/channels/approvals';
import { appApprovalLink, appCaller } from '../src/channels/surfaces/app';
import { runBook } from '../src/channels/background-runs';
import { durableConversationStore } from '../src/channels/conversation-store';
import { episodeIndex, indexedConversationStore, scrubEpisodeTexts } from '../src/channels/episodes';
import { ownerEffectLedger } from '../src/channels/owner-effect-ledger';
import { ownerTurnTrace, surfaceOfTrace } from '../src/channels/owner-turn-envelope';
import { forgetBarrier, resultOrigin } from '../src/context-composer/forget-barrier';
import { recallChain } from '../src/history/recall-chain';
import { barrierMemory } from '../src/context-composer/forget-barrier';
import { claimStore, FORGOTTEN } from '../src/memory/claims';
import { whyJson } from '../src/tools/why-trail';
import { holdsIn } from '../src/memory/forget-guard';
import { episodesFromSearchTool, recallForTurn, withinReach } from '../src/memory/turn-recall';
import { jobBook } from '../src/tasks/jobs';
import { memoryHandlers, type MemoryToolContext } from '../src/tools/live/memory';
import { searchEpisodesHandler } from '../src/tools/live/search-episodes';
import { searchHistoryHandler } from '../src/tools/live/search-history';
import { z } from 'zod';

const DAY = 24 * 60 * 60_000;
const NOW = Date.parse('2026-11-04T18:00:00Z');
const LAST_WEEK = NOW - 7 * DAY;
const OWNER = 'owner:1';
const OWNER_TURN = { trigger: 'user_message' } as never;
let sequence = 0;

const entry = (id: string, surface: string, text: string, parentId: string | null) => ({
  id, ownerId: OWNER, chatId: `${surface}-chat`, parentId, threadAnchorId: null, surface, modelPayload: text, appPayload: text,
  modelProjection: { mode: 'include' as const }, role: id.endsWith('-reply') ? 'assistant' as const : 'user' as const, inputOrigin: id.endsWith('-reply') ? undefined : 'owner' as const,
});

type World = Awaited<ReturnType<typeof seed>>;
// Last week on WhatsApp the owner asked for the Lisbon flight; Waldo replied, remembered the seat, delegated the search and
// raised a mail card in the travel agent's thread. The same week on the app they talked about the agenda.
const seed = async (state: DurableObjectState, held: string[] = []) => {
  const sql = state.storage.sql, transaction = <T>(work: () => T) => state.storage.transactionSync(work);
  const index = episodeIndex(sql);
  let at = LAST_WEEK;
  const store = indexedConversationStore(durableConversationStore(state.storage), index, () => at);
  const wa = ownerTurnTrace('whatsapp', 101), app = ownerTurnTrace('app', 55);
  await store.save([entry(wa, 'whatsapp', 'Can you book the Lisbon flight for the offsite? Aisle seat please', null)], wa);
  at += 60_000;
  await store.save([entry(`${wa}-reply`, 'whatsapp', "On it: I'll find two Lisbon flights for the offsite and come back.", wa)], `${wa}-reply`);
  at += DAY;
  await store.save([entry(app, 'app', 'The Lisbon offsite agenda draft is in Drive', null)], app);
  at += 60_000;
  await store.save([entry(`${app}-reply`, 'app', 'Got it, I can see the agenda draft.', app)], `${app}-reply`);
  at += DAY;
  await store.save([entry(ownerTurnTrace('whatsapp', 140), 'whatsapp', 'Slept 5 hours, HRV 38, so a slow morning', null)], ownerTurnTrace('whatsapp', 140));

  const memory = claimStore(sql, transaction);
  const handlers = memoryHandlers({ sql, store: memory, transaction, conversationRef: 'whatsapp-chat', hideHistory: async () => undefined });
  const remember = handlers.find(handler => handler.name === 'remember')!;
  const said = (ref: string, text: string) => ({ authenticatedUserId: OWNER, trigger: 'user_message', memoryTurn: { ownerId: OWNER, conversationRef: 'whatsapp-chat', current: { message_ref: ref, text }, recent: [] } }) as unknown as MemoryToolContext;
  expect(await remember.handle(remember.schema.parse({ kind: 'preference', text: 'Prefers an aisle seat on flights', evidence_quote: 'Aisle seat please' }), said(wa, 'Can you book the Lisbon flight for the offsite? Aisle seat please'))).toMatchObject({ ok: true });
  expect(await remember.handle(remember.schema.parse({ kind: 'health', text: 'Slept 5 hours with HRV 38', evidence_quote: 'Slept 5 hours, HRV 38' }), said(ownerTurnTrace('whatsapp', 140), 'Slept 5 hours, HRV 38, so a slow morning'))).toMatchObject({ ok: true });

  let n = 0;
  const runs = runBook(sql, { timezone: 'UTC', now: () => new Date(LAST_WEEK + 120_000) }, () => `r${++n}`);
  const run = runs.start('delegate_task', wa);
  runs.finish(run.id, 'completed', 'Found two Lisbon flights for the offsite');
  const jobs = jobBook(sql, { now: () => LAST_WEEK + 180_000, newId: () => 'job0trip0001', newToken: () => 'tok' });
  const { job } = jobs.create({ kind: 'task', profile: 'reader', idempotencyKey: `${wa}:call-2`, origin: wa, surface: 'whatsapp', dueAt: LAST_WEEK, deadlineAt: LAST_WEEK + DAY,
    brief: { title: 'Lisbon fares for the offsite', goal: 'Compare fares.', context: '', done_when: 'Two options.', effort: 'standard', timezone: 'UTC', started_at: LAST_WEEK } });

  approvalDesk(sql, { surface: 'app', owner: 7_000_000_000_001, call: appCaller(), appLink: appApprovalLink, google: async () => null, newId: () => 'x', now: () => NOW, timezone: 'UTC', log: () => undefined,
    commit: work => state.storage.transactionSync(work), effects: ownerEffectLedger(state.storage, () => NOW) });
  const mail = { to: ['agent@example.test'], subject: 'Lisbon flights', body: 'Please hold two aisle seats.', thread_id: 'thr-lisbon-1', message_id: '<m1@example.test>', raw: 'x', digest: 'd' } satisfies EmailSendProposal;
  sql.exec("INSERT INTO ledger (id, kind, status, summary, payload_json, created_at, decided_at) VALUES ('card1', 'email_send', 'done', 'Email the agent about Lisbon flights', ?, ?, ?)", JSON.stringify(mail), LAST_WEEK + 240_000, LAST_WEEK + 300_000);
  const calendar = { action: 'move', title: 'Offsite prep', event_id: 'evt-prep-9', start: '2026-10-30T10:00:00Z', end: '2026-10-30T11:00:00Z', reason: 'clash' };
  sql.exec("INSERT INTO ledger (id, kind, status, summary, payload_json, created_at, decided_at) VALUES ('card2', 'calendar_change', 'done', 'Move offsite prep to Thursday', ?, ?, ?)", JSON.stringify(calendar), LAST_WEEK + 250_000, LAST_WEEK + 310_000);
  // The why trail behind the calendar card, as whyJson stores it: the reads the turn made, by source.
  const why = whyJson([
    { at: LAST_WEEK + 200_000, verb: 'read', label: 'The agent asked to move prep before the flight', source: { kind: 'mail_thread', ref: 'thr-agent-7' } },
    { at: LAST_WEEK + 210_000, verb: 'checked', label: 'Thursday morning is free', source: { kind: 'calendar_free_busy', ref: 'primary' } },
    { at: LAST_WEEK + 220_000, verb: 'found', label: 'Form is steady this week', source: { kind: 'health_score', ref: 'form' } },
  ]);
  sql.exec("UPDATE ledger SET why_json = ? WHERE id = 'card2'", why);

  const topics = () => held;
  const chain = recallChain({ sql, claims: barrierMemory(memory, topics), held: () => holdsIn(topics()), approvalSummary: id => ledgerSummary(sql, id) });
  const episodes = searchEpisodesHandler(index, chain);
  const history = searchHistoryHandler(sql, id => ledgerSummary(sql, id), chain);
  const read = async (handler: typeof episodes | typeof history, args: unknown, ctx: Readonly<{ memoryOutside?: boolean; trigger?: string; recallRowOnly?: boolean }> = {}) => {
    const result = await handler.handle(handler.schema.parse(args) as never, { trigger: 'user_message', ...ctx } as never);
    if (!result.ok) throw new Error(result.error);
    return result.data as never;
  };
  const rowOf = (entryId: string) => String(sql.exec<{ ref: number }>('SELECT rowid AS ref FROM episodes WHERE entry_id = ? ORDER BY rowid LIMIT 1', entryId).one().ref);
  return { sql, index, memory, jobs, handlers, chain, episodes, history, read, rowOf, wa, app, run: run.id, job: job.id, held };
};
const inOwner = <R>(work: (state: DurableObjectState) => Promise<R>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`recall-chain-${sequence++}`)), (_instance, state) => work(state));
const rels = (links: readonly RecallLink[] | undefined) => (links ?? []).map(link => `${link.rel} ${link.ref}`);
type EpisodeRead = { episode: { ref: string; surface?: string | null; links?: RecallLink[] } | null };
type EpisodeHits = { hits: { ref: string; entry_id: string; surface?: string | null; links?: RecallLink[] }[] };

describe('the surface of a stored turn', () => {
  it('reads back what ownerTurnTrace wrote, for the owner message and its reply, and nothing for machine rows', () => {
    expect(['telegram', 'whatsapp', 'imessage', 'app'].map(surface => surfaceOfTrace(ownerTurnTrace(surface, 12)))).toEqual(['telegram', 'whatsapp', 'imessage', 'app']);
    expect(surfaceOfTrace(`${ownerTurnTrace('whatsapp', 12)}-reply`)).toBe('whatsapp');
    expect(['scheduled-0b6f2c1e-77aa-4c55-9d1e-3b0f8a1c2d3e', 'reminder:ab:1:0', 'reminder:ab:1:0-reply', 'nightly-memory', 'app-', 'tg-x'].map(surfaceOfTrace)).toEqual([null, null, null, null, null, null]);
  });
});

describe('search_episodes with the recall chain', () => {
  it('keeps a search to one surface and names each hit\'s surface', async () => {
    const result = await inOwner(async state => {
      const world = await seed(state);
      return { all: await world.read(world.episodes, { query: 'Lisbon offsite' }) as EpisodeHits, whatsapp: await world.read(world.episodes, { query: 'Lisbon offsite', surface: 'whatsapp' }) as EpisodeHits };
    });
    expect(new Set(result.all.hits.map(hit => hit.surface))).toEqual(new Set(['whatsapp', 'app']));
    expect(result.whatsapp.hits.map(hit => hit.entry_id).sort()).toEqual(['whatsapp-101', 'whatsapp-101-reply']);
    expect(result.whatsapp.hits.every(hit => hit.surface === 'whatsapp')).toBe(true);
  });

  it('reads a message with the rows next to it: its reply, the turns around it, what was learned and what it started', async () => {
    const result = await inOwner(async state => {
      const world = await seed(state);
      const read = await world.read(world.episodes, { ref: world.rowOf(world.wa) }) as EpisodeRead;
      return { read, reply: world.rowOf(`${world.wa}-reply`), next: world.rowOf('whatsapp-140'), run: world.run, job: world.job };
    });
    const links = result.read.episode!.links!;
    expect(result.read.episode!.surface).toBe('whatsapp');
    expect(rels(links)).toEqual(expect.arrayContaining([`reply ${result.reply}`, `after ${result.next}`, `started background_runs:${result.run}`, `started task_jobs:${result.job}`]));
    expect(links.find(link => link.rel === 'learned')).toMatchObject({ ref: expect.stringMatching(/^c\d+$/), line: expect.stringContaining('aisle seat') });
    // The app turn is another surface's thread, not this one's next turn.
    expect(links.some(link => link.line.includes('agenda'))).toBe(false);
    for (const link of links) expect(link.line.length).toBeLessThanOrEqual(80);
  });

  it('inlines at most two links per hit, and every link ref reads back with its own tool', async () => {
    await inOwner(async state => {
      const world = await seed(state);
      const found = await world.read(world.episodes, { query: 'Lisbon flight', surface: 'whatsapp' }) as EpisodeHits;
      const links = found.hits.flatMap(hit => hit.links ?? []);
      expect(found.hits.every(hit => (hit.links ?? []).length <= 2)).toBe(true);
      expect(links.length).toBeGreaterThan(0);
      for (const link of [...links, ...((await world.read(world.episodes, { ref: world.rowOf(world.wa) }) as EpisodeRead).episode!.links!)]) {
        if (/^\d+$/.test(link.ref)) expect((await world.read(world.episodes, { ref: link.ref }) as EpisodeRead).episode).not.toBeNull();
        else if (/^c\d+$/.test(link.ref)) expect(world.memory.claims().some(claim => `c${claim.id}` === link.ref)).toBe(true);
        else expect((await world.read(world.history, { ref: link.ref }) as SearchHistoryResult).entries).toHaveLength(1);
      }
    });
  });

  it('shows no health number in a link line, and names a health note by its kind only', async () => {
    const result = await inOwner(async state => {
      const world = await seed(state);
      const before = await world.read(world.episodes, { ref: world.rowOf(`${world.wa}-reply`) }) as EpisodeRead;
      const health = await world.read(world.episodes, { ref: world.rowOf('whatsapp-140') }) as EpisodeRead;
      const outside = await world.read(world.episodes, { ref: world.rowOf('whatsapp-140') }, { memoryOutside: true }) as EpisodeRead;
      const outsideSeat = await world.read(world.episodes, { ref: world.rowOf(world.wa) }, { memoryOutside: true }) as EpisodeRead;
      return { before: before.episode!.links!, health: health.episode!.links!, outside: outside.episode!.links!, outsideSeat: outsideSeat.episode!.links! };
    });
    const lines = [...result.before, ...result.health].map(link => link.line).join('\n');
    expect(lines).not.toMatch(/\b5 hours\b|\b38\b/);
    expect(result.health.find(link => link.rel === 'learned')?.line).toBe('health note');
    // A turn built from outside content reads memory without health, so the health note is not linked there at all.
    expect(result.outside.some(link => link.rel === 'learned')).toBe(false);
    expect(result.outsideSeat.some(link => link.rel === 'learned')).toBe(true);
  });
});

describe('what a link names', () => {
  it('links a message\'s runs and tasks only on a turn that has search_history, and links nothing on a row-only read', async () => {
    const result = await inOwner(async state => {
      const world = await seed(state);
      const at = (trigger: string) => world.read(world.episodes, { ref: world.rowOf(world.wa) }, { trigger }) as Promise<EpisodeRead>;
      return { owner: await at('user_message'), sweep: await at('pre_brief_sweep'), row: await world.read(world.episodes, { ref: world.rowOf(world.wa) }, { recallRowOnly: true }) as EpisodeRead };
    });
    expect(rels(result.owner.episode!.links).some(rel => rel.startsWith('started '))).toBe(true);
    expect(rels(result.sweep.episode!.links).some(rel => rel.startsWith('started '))).toBe(false);
    expect(rels(result.sweep.episode!.links).some(rel => rel.startsWith('reply '))).toBe(true);
    expect(result.row.episode).toMatchObject({ entry_id: 'whatsapp-101' });
    expect(result.row.episode).not.toHaveProperty('links');
  });

  it('names an owner\'s own words over a quote that came first, and skips rows that only share the prefix', async () => {
    const result = await inOwner(async state => {
      const world = await seed(state);
      const index = world.index;
      let at = NOW;
      // A split owner message stores its quote before its own words; a did-not-finish row shares the app prefix.
      index.add('app-70', 'quoted', 'Forwarded: the venue contract terms', at);
      index.add('app-70', 'owner_said', 'Can you check these terms tonight?', at);
      at += 1;
      index.add('app-70-did-not-finish', 'system', 'That turn did not finish.', at);
      index.add('app-70-reply', 'waldo', 'Checking the terms now.', at + 1);
      index.add('app-71', 'owner_said', 'Thanks for that', at + 2);
      const reply = await world.read(world.episodes, { ref: world.rowOf('app-70-reply') }) as EpisodeRead;
      return { links: reply.episode!.links!, own: world.sql.exec<{ ref: number }>("SELECT rowid AS ref FROM episodes WHERE entry_id = 'app-70' AND speaker = 'owner_said'").one().ref, next: world.rowOf('app-71') };
    });
    expect(result.links.find(link => link.rel === 'reply_to')).toMatchObject({ ref: String(result.own), line: expect.stringContaining('check these terms') });
    expect(result.links.find(link => link.rel === 'after')?.ref).toBe(result.next);
  });

  it('keeps turn recall\'s messages when a link cannot be read back', async () => {
    const result = await inOwner(async state => {
      const world = await seed(state);
      const search = episodesFromSearchTool(world.episodes as never, OWNER_TURN);
      const failing = { ...search, get: async (ref: string) => { if (ref === world.rowOf(`${world.wa}-reply`) || ref === world.rowOf('whatsapp-140')) throw new Error('read failed'); return search.get(ref); } };
      return { hits: await withinReach(failing, () => true).search('Lisbon flight', 5), reply: world.rowOf(`${world.wa}-reply`) };
    });
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits.flatMap(hit => hit.links ?? []).some(link => link.ref === result.reply)).toBe(false);
  });
});

describe('search_history with the recall chain', () => {
  it('reads a run, a task and a card with what they came from and what they act on', async () => {
    const result = await inOwner(async state => {
      const world = await seed(state);
      const one = async (ref: string) => (await world.read(world.history, { ref }) as SearchHistoryResult).entries;
      return { run: await one(`background_runs:${world.run}`), job: await one(`task_jobs:${world.job}`), mail: await one('ledger:card1'), calendar: await one('ledger:card2'), none: await one('ledger:nope'), wa: world.rowOf(world.wa) };
    });
    expect(result.run[0]).toMatchObject({ ref: expect.stringContaining('background_runs:'), summary: 'Found two Lisbon flights for the offsite' });
    expect(rels(result.run[0]!.links)).toEqual([`from ${result.wa}`]);
    expect(rels(result.job[0]!.links)).toEqual([`from ${result.wa}`]);
    expect(result.mail[0]!.links).toEqual([{ ref: 'mail:thr-lisbon-1', rel: 'acts_on', line: 'the mail thread this card sends in (read_thread)' }]);
    // The card's own event, then the mail thread its why trail read; free/busy and health steps name no row to follow.
    expect(result.calendar[0]!.links).toEqual([
      { ref: 'event:evt-prep-9', rel: 'acts_on', line: 'the calendar event this card changes, at 2026-10-30T10:00:00Z' },
      { ref: 'mail:thr-agent-7', rel: 'read', line: 'read: The agent asked to move prep before the flight' },
    ]);
    expect(result.none).toEqual([]);
  });

  it('lists entries with at most two links each', async () => {
    const result = await inOwner(async state => { const world = await seed(state); return await world.read(world.history, { query: 'Lisbon' }) as SearchHistoryResult; });
    expect(result.entries.length).toBeGreaterThan(1);
    expect(result.entries.every(entry => (entry.links ?? []).length <= 2)).toBe(true);
    // A list never looks a message up by its entry id, which reads the whole index; a read by ref does.
    expect(result.entries.flatMap(entry => entry.links ?? []).some(link => link.rel === 'from')).toBe(false);
  });
});

describe('the recall chain and forget', () => {
  it('drops a link whose stored row carries a topic being forgotten, and keeps the row it hangs from', async () => {
    const result = await inOwner(async state => {
      const world = await seed(state, ['aisle seat']);
      const read = await world.read(world.episodes, { ref: world.rowOf(`${world.wa}-reply`) }) as EpisodeRead;
      const run = (await world.read(world.history, { ref: `background_runs:${world.run}` }) as SearchHistoryResult).entries;
      return { read, run };
    });
    // The owner's message itself carries the words, so the reply loses that link and keeps the rest; the run, whose own
    // summary is clean, keeps its row and loses its link to the message.
    expect(result.read.episode).not.toBeNull();
    expect(rels(result.read.episode!.links).some(rel => rel.startsWith('reply_to '))).toBe(false);
    expect(result.run).toHaveLength(1);
    expect(result.run[0]!.links).toEqual([]);
  });

  it('after the purge, no link line carries the topic, and the barrier has nothing left to cut', async () => {
    const result = await inOwner(async state => {
      const world = await seed(state);
      // The stores the forget purge runs over these rows: the episode index, memory (which takes a run's summary) and the job book.
      scrubEpisodeTexts(world.sql, ['Lisbon'], FORGOTTEN);
      expect(world.memory.purge([], new Date(NOW).toISOString(), ['Lisbon']).ready).toBe(true);
      expect(world.jobs.forget(['Lisbon']).remaining).toBe(0);
      const read = await world.read(world.episodes, { ref: world.rowOf('whatsapp-140') }) as EpisodeRead;
      const job = await world.read(world.history, { ref: `task_jobs:${world.job}` }) as SearchHistoryResult;
      return { read, job };
    });
    expect(JSON.stringify(result)).not.toMatch(/lisbon/i);
    const tally = { dropped: 0, redacted: 0 };
    forgetBarrier(['Lisbon']).structured(result.read, resultOrigin('search_episodes'), tally);
    expect(tally).toEqual({ dropped: 0, redacted: 0 });
  });
});

describe('the recall chain switched off', () => {
  it('leaves both tools exactly as they were: schema, description and every byte of their results', async () => {
    const result = await inOwner(async state => {
      const world = await seed(state);
      const index = world.index;
      const plainEpisodes = searchEpisodesHandler(index), plainHistory = searchHistoryHandler(world.sql, id => ledgerSummary(world.sql, id));
      const plain = async (handler: typeof plainEpisodes | typeof plainHistory, args: unknown) => JSON.stringify(await handler.handle(handler.schema.parse(args) as never, OWNER_TURN));
      return {
        hits: await plain(plainEpisodes, { query: 'Lisbon flight' }), ref: await plain(plainEpisodes, { ref: world.rowOf(world.wa) }), history: await plain(plainHistory, { query: 'Lisbon' }),
        surfaceArg: plainEpisodes.schema.safeParse({ query: 'x', surface: 'app' }).success, refArg: plainHistory.schema.safeParse({ ref: 'ledger:card1' }).success,
        descriptions: [plainEpisodes.description, plainHistory.description, world.episodes.description, world.history.description],
      };
    });
    expect(result.hits).not.toMatch(/"(surface|links)"/);
    expect(result.ref).not.toMatch(/"(surface|links)"/);
    expect(result.history).not.toMatch(/"links"/);
    expect([result.surfaceArg, result.refArg]).toEqual([false, false]);
    expect(result.descriptions[0]).not.toBe(result.descriptions[2]);
    expect(result.descriptions[0]).not.toMatch(/surface|link/);
    expect(result.descriptions[1]).not.toMatch(/\blinks?\b/);
  });
});

describe('turn recall with the recall chain', () => {
  it('inlines a hit\'s surface and its links, and falls back to the plain line when the links do not fit', async () => {
    const result = await inOwner(async state => {
      const world = await seed(state);
      const recall = (handler: typeof world.episodes, room: number) => recallForTurn({ claims: { recall: () => [] }, episodes: episodesFromSearchTool(handler as never, OWNER_TURN), question: 'what was the Lisbon flight thing', room, holds: () => false });
      return { on: (await recall(world.episodes, 3_000)).text, tight: (await recall(world.episodes, 520)).text, off: (await recall(searchEpisodesHandler(world.index), 3_000)).text };
    });
    expect(result.on).toMatch(/whatsapp, ref \d+\] .*Lisbon/);
    expect(result.on).toMatch(/→ (c\d+|\d+|background_runs:\S+|task_jobs:\S+) (reply|reply_to|after|before|learned|started)/);
    expect(result.off).not.toMatch(/whatsapp|→/);
    expect(result.tight.length).toBeLessThanOrEqual(520);
    expect(result.tight).toMatch(/whatsapp, ref \d+\]/);
    expect(result.tight).not.toMatch(/→/);
    // A link to a message that is itself recalled is left out.
    expect(result.on).not.toMatch(/→ \d+ reply_to/);
  });
});

// Before and after, over one seeded world, for "what happened with the Lisbon flight thing we discussed on WhatsApp last
// week": the fewest calls that reach the owner's message, Waldo's reply and what the delegated run found, given only what
// each answer shows, and the characters the model reads on the way. The path is fixed, not a model's choice; a live model is
// measured by the nightly eval, not here. Each extra call is one more model round, which sends the whole prompt again.
describe('turn recall under its budget with the recall chain', () => {
  it('recalls the same messages and notes as with the chain off, and spends only the room left on links', async () => {
    const result = await inOwner(async state => {
      const world = await seed(state);
      let at = NOW;
      const store = indexedConversationStore(durableConversationStore(state.storage), world.index, () => at);
      for (let n = 0; n < 6; n += 1) {
        at += 60_000;
        await store.save([entry(`whatsapp-${200 + n}`, 'whatsapp', `Lisbon flight detail number ${n}: the offsite agenda, the hotel and the long ride from the airport`, null)], `whatsapp-${200 + n}`);
        // A reply that shares no word with the question, so each hit links a row recall does not show.
        await store.save([entry(`whatsapp-${200 + n}-reply`, 'whatsapp', `Noted, will keep it in mind ${n}`, `whatsapp-${200 + n}`)], `whatsapp-${200 + n}-reply`);
      }
      const notes = Array.from({ length: 8 }, (_value, n) => ({ id: 900 + n, kind: 'fact', text: `Lisbon offsite note ${n}: ${'the team wants a quiet hotel near the river with an early checkin and late checkout '.repeat(2)}`, source: 'stated', evidence: 'owner said', origin: 'owner', status: 'active', created_at: '2026-10-28T00:00:00Z', last_seen_at: '2026-10-28T00:00:00Z', seen_count: 1 }));
      const recall = async (handler: typeof world.episodes) => (await recallForTurn({ claims: { recall: () => notes }, episodes: episodesFromSearchTool(handler as never, OWNER_TURN), question: 'the Lisbon flight and offsite agenda', room: 3_000, holds: () => false, stubs: true })).text;
      return { on: await recall(world.episodes), off: await recall(searchEpisodesHandler(world.index)) };
    });
    const refs = (text: string) => [...text.matchAll(/ref (\d+)\]/g)].map(match => match[1]).sort();
    const notes = (text: string) => [...text.matchAll(/\[c(\d+)/g)].map(match => match[1]).sort();
    // The budget binds: something did not fit.
    expect(result.off).toMatch(/more matches did not fit/);
    expect(refs(result.on)).toEqual(refs(result.off));
    expect(notes(result.on)).toEqual(notes(result.off));
    expect(result.on.length).toBeLessThanOrEqual(3_000);
  });
});

describe('turn recall in one chat with the recall chain', () => {
  it('leaves out a link to a message of another chat, as it leaves out that message', async () => {
    const result = await inOwner(async state => {
      const world = await seed(state);
      // A second app thread, right after the first: the first thread's next app turn, in another chat.
      let at = NOW;
      const store = indexedConversationStore(durableConversationStore(state.storage), world.index, () => at);
      await store.save([entry('app-60', 'app', 'Second thread: dinner plans for Friday', null)], 'app-60');
      at += 1;
      const search = episodesFromSearchTool(world.episodes as never, OWNER_TURN);
      const linked = (await search.search('agenda draft', 5)).find(hit => hit.entry_id === 'app-55')!.links!;
      const otherChat = (entryId: string) => !entryId.startsWith('app-60');
      const hits = await withinReach(search, otherChat).search('agenda draft', 5);
      return { linked, kept: hits.find(hit => hit.entry_id === 'app-55')!.links!, entries: hits.map(hit => hit.entry_id), other: world.rowOf('app-60') };
    });
    expect(rels(result.linked)).toContain(`after ${result.other}`);
    expect(result.entries).not.toContain('app-60');
    expect(result.kept).toEqual(result.linked.filter(link => link.ref !== result.other));
  });
});

describe('the recall chain, measured', () => {
  it('reaches the thread in one call instead of two, for a bounded cost in definitions and recall', async () => {
    const result = await inOwner(async state => {
      const world = await seed(state);
      const plainEpisodes = searchEpisodesHandler(world.index), plainHistory = searchHistoryHandler(world.sql, id => ledgerSummary(world.sql, id));
      const call = async (handler: typeof plainEpisodes | typeof plainHistory, args: unknown) => JSON.stringify(await handler.handle(handler.schema.parse(args) as never, OWNER_TURN));
      // Off: the messages carry no link to what was done about them, so a second search finds the run by its words.
      const off = [await call(plainEpisodes, { query: 'Lisbon flight' }), await call(plainHistory, { query: 'Lisbon' })];
      const on = [await call(world.episodes, { query: 'Lisbon flight', surface: 'whatsapp' })];
      const definition = (handler: typeof plainEpisodes | typeof plainHistory) => handler.description.length + JSON.stringify(z.toJSONSchema(handler.schema, { io: 'input' })).length;
      const recall = async (handler: typeof world.episodes, question: string) => (await recallForTurn({ claims: { recall: () => [] }, episodes: episodesFromSearchTool(handler as never, OWNER_TURN), question, room: 3_000, holds: () => false })).text.length;
      return {
        off, on,
        definitions: { off: definition(plainEpisodes) + definition(plainHistory), on: definition(world.episodes) + definition(world.history) },
        recall: { off: await recall(plainEpisodes, 'is Lisbon warm this week'), on: await recall(world.episodes, 'is Lisbon warm this week') },
        idle: { off: await recall(plainEpisodes, 'brilliant, cheers mate'), on: await recall(world.episodes, 'brilliant, cheers mate') },
      };
    });
    const chars = (outputs: readonly string[]) => outputs.reduce((sum, output) => sum + output.length, 0);
    // The owner's message and the reply as hits (by their entry ids; a snippet marks the matched words), the run by its summary.
    const reached = (outputs: readonly string[]) => ['"entry_id":"whatsapp-101"', '"entry_id":"whatsapp-101-reply"', 'Found two Lisbon flights'].every(fact => outputs.join('\n').includes(fact));
    console.log(JSON.stringify({ calls: { off: result.off.length, on: result.on.length }, tool_output_chars: { off: chars(result.off), on: chars(result.on) }, definition_chars: result.definitions, recall_block_chars: result.recall, idle_turn_recall_chars: result.idle }));
    expect(reached(result.off)).toBe(true);
    expect(reached(result.on)).toBe(true);
    expect(result.on.length).toBeLessThan(result.off.length);
    // In the off answer nothing ties the run to the message; on, the run is a link of that very message.
    expect(result.off[1]).not.toMatch(/whatsapp-101|"from"/);
    expect(result.on[0]).toMatch(/"rel":"started","line":"delegate_task completed: Found two Lisbon flights/);
    expect(result.definitions.on - result.definitions.off).toBeLessThan(1_600);
    expect(result.idle).toEqual({ off: 0, on: 0 });
  });
});
