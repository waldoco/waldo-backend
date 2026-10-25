import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { appWelcomeBuildV1Schema, type AppNodeSourceV1 } from '../../contracts/src/app/controls';
import { applyPromotion, claimStore, textFingerprint, turnMemoryPrompt, type ClaimStore } from '../src/memory/claims';
import { nodeConfirmation, nodeSources } from '../src/memory/node-sources';
import { readMemoryGraph } from '../src/channels/memory-graph';
import { barrierMemory } from '../src/context-composer/forget-barrier';
import {
  confirmWelcomeNode, correctWelcomeNode, runWelcome, WELCOME_MAX_NODES, WELCOME_SCHEMA, welcomeBuild, welcomeSupportIds,
  type StageInput, type WelcomeDeps, type WelcomeStage,
} from '../src/onboarding/welcome';

let sequence = 0;
const withSql = <T>(fn: (sql: SqlStorage, transaction: <R>(work: () => R) => R) => Promise<T> | T) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`welcome-${sequence++}`)), (_instance, state) => fn(state.storage.sql, (work) => state.storage.transactionSync(work)));

const T0 = Date.parse('2026-10-25T13:00:00Z');
type Node = Readonly<{ domain: string; label: string; summary: string; observation: string; source: string; pointers: readonly string[] }>;
const answer = (...nodes: Node[]) => JSON.stringify({ nodes });
const healthNode = (over: Partial<Node> = {}): Node => ({ domain: 'health', label: 'Late weekend sleeper', summary: 'Sleeps in on weekends, then starts slowly.', observation: 'Weekend nights end later than weeknights.', source: 'apple_health', pointers: ['sleep_midpoint'], ...over });
const calendarNode = (over: Partial<Node> = {}): Node => ({ domain: 'work', label: 'Monday planning ritual', summary: 'Blocks Monday mornings to plan the week.', observation: 'A weekly Monday planning block recurs.', source: 'calendar', pointers: ['evt_a'], ...over });
const mailNode = (over: Partial<Node> = {}): Node => ({ domain: 'people', label: 'Close with the design team', summary: 'Writes most often with the design team.', observation: 'Many threads with the design team domain.', source: 'gmail', pointers: ['thr_1'], ...over });

const input = (sources: readonly AppNodeSourceV1[], pointers: readonly string[]): StageInput =>
  ({ kind: 'input', text: `data for ${sources.join(',')}`, sources, pointers: new Set(pointers) });

const deps = (sql: SqlStorage, transaction: <R>(work: () => R) => R, over: Partial<WelcomeDeps> & { answers?: Partial<Record<WelcomeStage, string>> } = {}) => {
  const claims = claimStore(sql, transaction);
  const build = welcomeBuild(sql, () => T0);
  const asked: WelcomeStage[] = [];
  const base: WelcomeDeps = {
    build, claims, transaction, now: () => T0,
    read: {
      health: async () => input(['apple_health'], ['sleep_midpoint', 'hrv']),
      calendar: async () => input(['calendar', 'tasks'], ['evt_a', 'evt_b']),
      mail: async () => input(['gmail'], ['thr_1', 'thr_2']),
      web: async () => ({ kind: 'settled', state: 'skipped' }),
    },
    ask: async (stage) => { asked.push(stage); return over.answers?.[stage] ?? answer(); },
  };
  return { claims, build, asked, deps: { ...base, ...over } as WelcomeDeps };
};

describe('welcome build: trigger', () => {
  it('starts once per owner: a second start, from either trigger, starts nothing', async () => {
    await withSql((sql) => {
      const build = welcomeBuild(sql, () => T0);
      expect(build.view().state).toBe('not_started');
      expect(build.start()).toBe(true);
      expect(build.start()).toBe(false);
      expect(welcomeBuild(sql, () => T0 + 60_000).start()).toBe(false);
      const view = build.view();
      expect(appWelcomeBuildV1Schema.parse(view)).toEqual({ state: 'building', started_at: T0, finished_at: null, nodes: 0, stages: { health: 'pending', calendar: 'pending', mail: 'pending', web: 'pending' } });
    });
  });

  it('progresses not_started, then building, then done, and runs each stage once', async () => {
    await withSql(async (sql, transaction) => {
      const { build, deps: d, asked } = deps(sql, transaction, { answers: { health: answer(healthNode()), calendar: answer(calendarNode()), mail: answer(mailNode()) } });
      build.start();
      await runWelcome(d);
      const view = appWelcomeBuildV1Schema.parse(build.view());
      expect(view).toMatchObject({ state: 'done', finished_at: T0, nodes: 3, stages: { health: 'done', calendar: 'done', mail: 'done', web: 'skipped' } });
      await runWelcome(d);
      expect(asked.sort()).toEqual(['calendar', 'health', 'mail']);
    });
  });

  it('resumes a stage left reading by an interrupted run, and only that stage', async () => {
    await withSql(async (sql, transaction) => {
      let now = T0;
      const claims = claimStore(sql, transaction), build = welcomeBuild(sql, () => now);
      build.start();
      transaction(() => build.begin('health'));
      expect(build.due()).toEqual(['calendar', 'mail', 'web']);
      now = T0 + 10 * 60_000;
      expect(welcomeBuild(sql, () => now).due()).toEqual(['health', 'calendar', 'mail', 'web']);
      expect(claims.nodes()).toEqual([]);
    });
  });
});

describe('welcome build: sources', () => {
  it('a skipped, revoked or failed source settles alone and never invents a node', async () => {
    await withSql(async (sql, transaction) => {
      const { build, claims, deps: d, asked } = deps(sql, transaction, {
        answers: { mail: answer(mailNode()) },
        read: {
          health: async () => ({ kind: 'settled', state: 'revoked' }),
          calendar: async () => { throw new Error('google 500'); },
          mail: async () => input(['gmail'], ['thr_1']),
          web: async () => ({ kind: 'settled', state: 'skipped' }),
        },
      });
      build.start();
      await runWelcome(d);
      expect(build.view()).toMatchObject({ state: 'done', nodes: 1, stages: { health: 'revoked', calendar: 'unavailable', mail: 'done', web: 'skipped' } });
      expect(asked).toEqual(['mail']);
      expect(claims.nodes().map((node) => node.label)).toEqual(['Close with the design team']);
    });
  });

  it('a source with nothing to read, and a model that finds nothing, both settle empty', async () => {
    await withSql(async (sql, transaction) => {
      const { build, claims, deps: d } = deps(sql, transaction, {
        read: { health: async () => ({ kind: 'settled', state: 'empty' }), calendar: async () => input(['calendar'], ['evt_a']), mail: async () => ({ kind: 'settled', state: 'skipped' }), web: async () => ({ kind: 'settled', state: 'skipped' }) },
      });
      build.start();
      await runWelcome(d);
      expect(build.view().stages).toEqual({ health: 'empty', calendar: 'empty', mail: 'skipped', web: 'skipped' });
      expect(claims.nodes()).toEqual([]);
    });
  });

  it('a malformed or failed model answer settles that stage unavailable', async () => {
    await withSql(async (sql, transaction) => {
      const { build, deps: d } = deps(sql, transaction, { answers: { health: 'not json' }, ask: async (stage) => { if (stage === 'mail') throw new Error('model down'); return stage === 'health' ? 'not json' : answer(calendarNode()); } });
      build.start();
      await runWelcome(d);
      expect(build.view().stages).toMatchObject({ health: 'unavailable', calendar: 'done', mail: 'unavailable' });
    });
  });
});

describe('welcome build: admission', () => {
  it('writes each node as Waldo\'s read: an inferred support claim, untrusted for mail and calendar, agent for health', async () => {
    await withSql(async (sql, transaction) => {
      const { build, claims, deps: d } = deps(sql, transaction, { answers: { health: answer(healthNode()), calendar: answer(calendarNode()), mail: answer(mailNode()) } });
      build.start();
      await runWelcome(d);
      const support = (label: string) => {
        const node = claims.nodes().find((row) => row.label === label)!;
        const [id] = JSON.parse(node.supporting_spots) as number[];
        return claims.allClaims().find((claim) => claim.id === id)!;
      };
      expect(support('Late weekend sleeper')).toMatchObject({ kind: 'observation', source: 'inferred', origin: 'agent', source_ref: 'welcome:apple_health:sleep_midpoint', verification_status: 'provisional' });
      expect(support('Monday planning ritual')).toMatchObject({ source: 'inferred', origin: 'untrusted', source_ref: 'welcome:calendar:evt_a' });
      expect(support('Close with the design team')).toMatchObject({ source: 'inferred', origin: 'untrusted', source_ref: 'welcome:gmail:thr_1' });
      // Outside text never reaches recall as an owner fact, and a support can never be pinned into every turn.
      expect(claims.recall('design team planning Monday')).toEqual([]);
      for (const label of ['Monday planning ritual', 'Close with the design team', 'Late weekend sleeper']) expect(claims.pin(support(label).id, 'profile', 1)).toBe(false);
    });
  });

  it('drops a node with a digit or a health reading, a source or pointer it was not given, or an unknown domain', async () => {
    await withSql(async (sql, transaction) => {
      const { build, claims, deps: d } = deps(sql, transaction, { answers: { health: answer(
        healthNode({ label: 'Sleeps 6 hours' }), healthNode({ summary: 'Resting heart rate around 52 bpm.' }), healthNode({ observation: 'HRV of 48 ms most nights' }),
        healthNode({ source: 'gmail' }), healthNode({ pointers: ['weight'] }), healthNode({ domain: 'finance' }), healthNode({ label: '' }),
        healthNode({ label: 'Steady evening walker', summary: 'Walks most evenings.', observation: 'Evening movement is regular.', pointers: ['hrv', 'not_given'] }),
      ) } });
      build.start();
      await runWelcome(d);
      expect(claims.nodes().map((node) => node.label)).toEqual(['Steady evening walker']);
      expect(claims.allClaims().map((claim) => claim.source_ref)).toEqual(['welcome:apple_health:hrv']);
      for (const table of ['claims', 'constellation_nodes']) {
        for (const row of sql.exec<Record<string, SqlStorageValue>>(`SELECT * FROM ${table}`).toArray()) {
          for (const column of table === 'claims' ? ['text', 'evidence'] : ['label', 'summary']) expect(String(row[column])).not.toMatch(/\p{Nd}/u);
        }
      }
    });
  });

  it('caps a stage at five nodes and the build at fifteen', async () => {
    await withSql(async (sql, transaction) => {
      const many = (make: (over: Partial<Node>) => Node) => answer(...Array.from({ length: 7 }, (_, index) => make({ label: `Pattern ${'abcdefg'[index]}` })));
      const { build, claims, deps: d } = deps(sql, transaction, { answers: { health: many(healthNode), calendar: many(calendarNode), mail: many(mailNode) } });
      build.start();
      await runWelcome(d);
      expect(claims.nodes()).toHaveLength(WELCOME_MAX_NODES);
      expect(build.view().nodes).toBe(WELCOME_MAX_NODES);
    });
  });

  it('never writes what the owner asked to forget', async () => {
    await withSql(async (sql, transaction) => {
      const { build, claims, deps: d } = deps(sql, transaction, { answers: { calendar: answer(calendarNode(), calendarNode({ label: 'Choir on Thursdays', summary: 'Sings with a choir every week.', observation: 'A weekly choir rehearsal.' })) } });
      // Barriers are content-free fingerprints of the exact text forgotten (a node forget bars its label).
      claims.barrier('Choir on Thursdays', new Date(T0).toISOString());
      build.start();
      await runWelcome(d);
      expect(claims.nodes().map((node) => node.label)).toEqual(['Monday planning ritual']);
    });
  });

  it('asks the model for structured output only', () => {
    expect(WELCOME_SCHEMA).toMatchObject({ type: 'object', additionalProperties: false, required: ['nodes'] });
  });
});

const built = async (sql: SqlStorage, transaction: <R>(work: () => R) => R) => {
  const { build, claims, deps: d } = deps(sql, transaction, { answers: { health: answer(healthNode()), calendar: answer(calendarNode()), mail: answer(mailNode()) } });
  build.start();
  await runWelcome(d);
  const node = (label: string) => claims.nodes().find((row) => row.label === label)!;
  return { claims, node };
};

describe('welcome nodes: confirm, correct, forget', () => {
  it('confirm makes every support the owner\'s own word', async () => {
    await withSql(async (sql, transaction) => {
      const { claims, node } = await built(sql, transaction);
      const id = node('Monday planning ritual').id;
      expect(confirmWelcomeNode(claims, id, new Date(T0).toISOString())).toBe(true);
      const ids = JSON.parse(node('Monday planning ritual').supporting_spots) as number[];
      expect(claims.allClaims().filter((claim) => ids.includes(claim.id)).map((claim) => [claim.origin, claim.verification_status])).toEqual([['owner', 'owner-grounded']]);
      expect(welcomeSupportIds(claims, id)).toEqual([]);
      expect(nodeConfirmation(claims.allClaims(), node('Monday planning ritual'))).toBe('confirmed');
      expect(confirmWelcomeNode(claims, 9_999, new Date(T0).toISOString())).toBe(false);
    });
  });

  it('correct replaces the node with the owner\'s words and hands back Waldo\'s old read to purge', async () => {
    await withSql(async (sql, transaction) => {
      const { claims, node } = await built(sql, transaction);
      const before = node('Late weekend sleeper');
      const old = welcomeSupportIds(claims, before.id);
      const result = transaction(() => correctWelcomeNode(claims, before.id, 'I sleep in on Sundays only', new Date(T0).toISOString()));
      expect(result).toEqual({ purge: old, barred: 'Late weekend sleeper' });
      const after = claims.nodes().find((row) => row.id === before.id)!;
      expect(after.label).toBe('I sleep in on Sundays only');
      const [support] = JSON.parse(after.supporting_spots) as number[];
      expect(claims.allClaims().find((claim) => claim.id === support)).toMatchObject({ origin: 'owner', source: 'stated', verification_status: 'owner-grounded', text: 'I sleep in on Sundays only' });
      expect(nodeConfirmation(claims.allClaims(), after)).toBe('confirmed');
      expect(claims.barriers().some((barrier) => barrier.topic_hash === textFingerprint('Late weekend sleeper'))).toBe(true);
    });
  });

  it('a forgotten welcome node takes its support with it, and a rerun of the same answer cannot bring it back', async () => {
    await withSql(async (sql, transaction) => {
      const { claims, node } = await built(sql, transaction);
      const target = node('Close with the design team');
      const supports = welcomeSupportIds(claims, target.id);
      claims.forgetNode(target.id);
      claims.barrier(target.label, new Date(T0).toISOString());
      claims.purge(supports, new Date(T0).toISOString());
      expect(claims.nodes().some((row) => row.label === target.label)).toBe(false);
      const again = deps(sql, transaction, { answers: { mail: answer(mailNode()) } });
      sql.exec('DELETE FROM welcome_builds');
      again.build.start();
      await runWelcome(again.deps);
      expect(claims.nodes().some((row) => row.label === target.label)).toBe(false);
    });
  });
});

describe('welcome nodes: what reads them', () => {
  it('the nightly promotion leaves a welcome node untouched', async () => {
    await withSql(async (sql, transaction) => {
      const { claims, node } = await built(sql, transaction);
      const before = node('Monday planning ritual');
      applyPromotion(claims, JSON.stringify({ nodes: [{ ...before, durable: true, reason: 'rewrite', label: 'Rewritten', supporting_spots: JSON.parse(before.supporting_spots) }], edges: [], promoted: [] }), '2026-10-26T02:00:00Z');
      expect(claims.nodes().find((row) => row.id === before.id)).toEqual(before);
    });
  });

  it('every chat turn carries the constellation, bounded, labelled as Waldo\'s read, and held topics stay out', async () => {
    await withSql(async (sql, transaction) => {
      const { claims } = await built(sql, transaction);
      const prompt = turnMemoryPrompt(claims, 'hi');
      const block = prompt.slice(prompt.indexOf('<owner_constellation>'), prompt.indexOf('</owner_constellation>') + '</owner_constellation>'.length);
      expect(block).toContain('Late weekend sleeper');
      expect(block).toContain('apple_health');
      expect(block).toContain("waldo's read");
      expect(block.length).toBeLessThanOrEqual(1_200);
      const held: ClaimStore = barrierMemory(claims, () => ['design team']);
      expect(turnMemoryPrompt(held, 'hi')).not.toContain('design team');
      expect(turnMemoryPrompt(claims, 'hi', 500)).not.toContain('<owner_constellation>');
    });
  });

  it('the app projection names each node\'s sources and whether the owner confirmed it', async () => {
    await withSql(async (sql, transaction) => {
      const { claims, node } = await built(sql, transaction);
      confirmWelcomeNode(claims, node('Monday planning ritual').id, new Date(T0).toISOString());
      const graph = readMemoryGraph(sql, 'memory');
      const shown = Object.fromEntries(graph.nodes.map((row) => [row.label, [row.sources, row.confirmation]]));
      expect(shown).toEqual({
        'Late weekend sleeper': [['apple_health'], 'waldos_read'],
        'Monday planning ritual': [['calendar'], 'confirmed'],
        'Close with the design team': [['gmail'], 'waldos_read'],
      });
      expect(nodeSources(claims.allClaims(), node('Late weekend sleeper'))).toEqual(['apple_health']);
    });
  });
});
