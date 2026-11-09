import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { applyPromotion, claimStore, memoryPrompt, turnMemoryPrompt, type ClaimStore } from '../src/memory/claims';
import { nodeConfirmation } from '../src/memory/node-sources';
import { outsideView } from '../src/memory/outside-view';
import { readMemoryGraph } from '../src/channels/memory-graph';
import { confirmWelcomeNode, correctWelcomeNode } from '../src/onboarding/welcome';
import { memoryHandlers, type MemoryToolContext } from '../src/tools/live/memory';

// A pattern counts as the owner's confirmed words only when the owner confirmed its own wording. Confirming the notes under it
// one by one confirms those notes, not the pattern Waldo wrote over them.
const AT = '2026-10-30T04:00:00Z';
let sequence = 0;
const withStore = <T>(fn: (store: ClaimStore, sql: SqlStorage) => T, name = `node-statement-${sequence++}`) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), (_instance, state) =>
    fn(claimStore(state.storage.sql, (work) => state.storage.transactionSync(work)), state.storage.sql));

const read = (store: ClaimStore, text: string, source: string, origin = 'untrusted') => {
  store.add({ kind: 'observation', text, source: 'inferred', evidence: 'welcome build', origin, source_ref: `welcome:${source}:p${sequence++}` }, AT);
  return store.allClaims().find((claim) => claim.text === text)!.id;
};
const owned = (store: ClaimStore, text: string, at = AT) => {
  store.add({ kind: 'observation', text, source: 'stated', evidence: `"${text}"`, origin: 'owner', source_ref: `owner, tg-${sequence++}` }, at);
  return store.allClaims().find((claim) => claim.text === text)!.id;
};
const mailNode = (store: ClaimStore) => {
  const supports = [read(store, 'Replies to investors before nine', 'gmail'), read(store, 'Books calls after lunch', 'gmail')];
  return { id: store.saveNode({ id: null, domain: 'work', label: 'Investor mornings', summary: 'Clears investor mail first thing', strength: 0.6, status: 'active', supporting_spots: supports }, AT), supports };
};
const healthNode = (store: ClaimStore) => {
  const support = read(store, 'Weekend nights end later', 'apple_health', 'agent');
  return { id: store.saveNode({ id: null, domain: 'health', label: 'Late weekend sleeper', summary: 'Sleeps in on weekends', strength: 0.5, status: 'active', supporting_spots: [support] }, AT), support };
};
const nodeOf = (store: ClaimStore, id: number) => store.nodes().find((node) => node.id === id)!;
const confirmation = (store: ClaimStore, id: number) => nodeConfirmation(store.allClaims(), nodeOf(store, id));
const statements = (store: ClaimStore) => store.allClaims().filter((claim) => claim.kind === 'node_statement');
const block = (store: ClaimStore) => turnMemoryPrompt(store, 'what is on today');

describe('confirming the notes under a pattern one by one', () => {
  it('confirms those notes but leaves the pattern Waldo\'s read, out of every turn', async () => {
    await withStore((store, sql) => {
      const { id, supports } = mailNode(store);
      for (const support of supports) expect(store.ownerGround(support, AT, 'owner, console')).toBe(true);
      expect(confirmation(store, id)).toBe('waldos_read');
      expect(block(store)).not.toContain('Investor mornings');
      expect(readMemoryGraph(sql, 'memory').nodes.find((node) => node.local_id === id)?.confirmation).toBe('waldos_read');
    });
  });

  it('does the same for a read of the owner\'s own setup answers, whose ref names no app source', async () => {
    await withStore((store) => {
      const support = read(store, 'Protects the first hour for deep work', 'setup:3', 'agent');
      const id = store.saveNode({ id: null, domain: 'routines', label: 'Guarded mornings', summary: 'Keeps mornings for focus', strength: 0.5, status: 'active', supporting_spots: [support] }, AT);
      expect(store.ownerGround(support, AT, 'owner, console')).toBe(true);
      expect(confirmation(store, id)).toBe('waldos_read');
    });
  });
});

describe('confirming the pattern itself', () => {
  it('records the owner\'s yes to its wording, grounds no note under it, and brings it into every turn', async () => {
    await withStore((store, sql) => {
      const { id, supports } = mailNode(store);
      expect(confirmWelcomeNode(store, id, AT, 'app:node.confirm')).toBe(true);
      expect(store.allClaims().filter((claim) => supports.includes(claim.id)).map((claim) => [claim.origin, claim.verification_status, claim.source]))
        .toEqual([['untrusted', 'provisional', 'inferred'], ['untrusted', 'provisional', 'inferred']]);
      const [statement] = statements(store);
      expect(statement).toMatchObject({ text: 'Investor mornings: Clears investor mail first thing', source: 'confirmed', origin: 'owner', verification_status: 'owner-grounded', source_ref: `node:${id}:app:node.confirm`, status: 'active' });
      expect(JSON.parse(nodeOf(store, id).supporting_spots)).toEqual([...supports, statement!.id]);
      expect(confirmation(store, id)).toBe('confirmed');
      expect(block(store)).toContain(`[n${id} · gmail · confirmed] Investor mornings: Clears investor mail first thing`);
      const graph = readMemoryGraph(sql, 'memory');
      expect(graph.state).toBe('available');
      const node = graph.nodes.find((row) => row.local_id === id)!;
      expect(node.confirmation).toBe('confirmed');
      expect(node.support.claim_ids).toEqual(supports.map((support) => `memory:claim:${support}`));
      expect(graph.claims.map((claim) => claim.local_id)).not.toContain(statement!.id);
    });
  });

  it('drops back to Waldo\'s read when the nightly rewrites its wording, and a second confirm replaces the first', async () => {
    await withStore((store) => {
      const { id, supports } = mailNode(store);
      confirmWelcomeNode(store, id, AT);
      const first = statements(store)[0]!.id;
      store.saveNode({ ...nodeOf(store, id), label: 'Investor-first mornings', supporting_spots: JSON.parse(nodeOf(store, id).supporting_spots) as number[] }, AT);
      expect(confirmation(store, id)).toBe('waldos_read');
      expect(block(store)).not.toContain('Investor-first mornings');
      expect(confirmWelcomeNode(store, id, AT)).toBe(true);
      const live = statements(store).filter((claim) => claim.status === 'active');
      expect(live.map((claim) => claim.text)).toEqual(['Investor-first mornings: Clears investor mail first thing']);
      expect(statements(store).find((claim) => claim.id === first)?.status).toBe('superseded');
      expect(JSON.parse(nodeOf(store, id).supporting_spots)).toEqual([...supports, live[0]!.id]);
      expect(confirmation(store, id)).toBe('confirmed');
    });
  });

  it('a pattern resting only on the owner\'s own words is still Waldo\'s wording until they confirm it', async () => {
    await withStore((store) => {
      const supports = [owned(store, 'Writes before ten'), owned(store, 'Mutes chat until noon', '2026-10-29T04:00:00Z')];
      const id = store.saveNode({ id: null, domain: 'work', label: 'Deep work mornings', summary: 'Focused work before noon', strength: 0.7, status: 'active', supporting_spots: supports }, AT);
      expect(confirmation(store, id)).toBe('waldos_read');
      expect(block(store)).toContain(`[n${id} · their words · waldo's read] Deep work mornings`);
      expect(confirmWelcomeNode(store, id, AT)).toBe(true);
      expect(block(store)).toContain(`[n${id} · their words · confirmed] Deep work mornings`);
    });
  });

  it('a correction replaces the node with the owner\'s words, which are their yes to it, and takes the old statement with it', async () => {
    await withStore((store) => {
      const { id } = mailNode(store);
      confirmWelcomeNode(store, id, AT);
      expect(correctWelcomeNode(store, id, 'Writes to investors after standup', AT)).not.toBeNull();
      expect(statements(store).map((claim) => [claim.text, claim.status])).toEqual([['Writes to investors after standup: Writes to investors after standup', 'active']]);
      expect(confirmation(store, id)).toBe('confirmed');
    });
  });
});

describe('a pattern the nightly promotion draws', () => {
  const DAY2 = '2026-10-31T04:00:00Z';
  const nightly = (store: ClaimStore, text: string, at: string) => {
    store.add({ kind: 'observation', text, source: 'inferred', evidence: 'nightly read of a mail thread', origin: 'untrusted' }, at);
    return store.allClaims().find((claim) => claim.text === text)!.id;
  };
  const promote = (store: ClaimStore, node: Readonly<{ id: number | null; label: string; summary: string }>, spots: readonly number[]) =>
    applyPromotion(store, JSON.stringify({ nodes: [{ ...node, domain: 'work', strength: 0.6, status: 'active', supporting_spots: spots, durable: true, reason: 'two days' }], edges: [], promoted: [] }), DAY2);

  it('is Waldo\'s read in every turn when its notes came from outside content, though the owner confirmed each note', async () => {
    await withStore((store, sql) => {
      const supports = [nightly(store, 'Thursday deadlines pile up', AT), nightly(store, 'Late replies on Thursdays', DAY2)];
      for (const support of supports) expect(store.ownerGround(support, DAY2, 'owner, console')).toBe(true);
      expect(promote(store, { id: null, label: 'Thursday crunch', summary: 'Thursdays run late' }, supports)).toBe('nodes1 edges0 promoted0');
      const id = store.nodes().find((node) => node.label === 'Thursday crunch')!.id;
      expect(confirmation(store, id)).toBe('waldos_read');
      expect(block(store)).not.toContain('· confirmed] Thursday crunch');
      expect(readMemoryGraph(sql, 'memory').nodes.find((node) => node.local_id === id)?.confirmation).toBe('waldos_read');
    });
  });

  it('keeps the owner\'s yes through a nightly re-save of the same wording, and drops it when the wording changes', async () => {
    await withStore((store) => {
      const supports = [owned(store, 'Writes before ten'), owned(store, 'Mutes chat until noon', DAY2)];
      expect(promote(store, { id: null, label: 'Deep mornings', summary: 'Focus first' }, supports)).toBe('nodes1 edges0 promoted0');
      const id = store.nodes().find((node) => node.label === 'Deep mornings')!.id;
      expect(confirmWelcomeNode(store, id, AT)).toBe(true);
      promote(store, { id, label: 'Deep mornings', summary: 'Focus first' }, supports);
      expect(confirmation(store, id)).toBe('confirmed');
      promote(store, { id, label: 'Deep mornings', summary: 'Focus until noon' }, supports);
      expect(confirmation(store, id)).toBe('waldos_read');
      expect(statements(store).filter((claim) => claim.status !== 'superseded')).toEqual([]);
    });
  });
});

describe('the statement is a record of the owner\'s yes, never a memory fact', () => {
  it('is never listed, recalled or shown to the nightly model', async () => {
    await withStore((store) => {
      const { id } = mailNode(store);
      confirmWelcomeNode(store, id, AT);
      const statement = statements(store)[0]!;
      expect(store.claims().map((claim) => claim.id)).not.toContain(statement.id);
      expect(store.claims('promoted').map((claim) => claim.id)).not.toContain(statement.id);
      expect(store.recall('investor mornings clears mail first thing')).toEqual([]);
      expect(store.recall('', 4, [statement.id])).toEqual([]);
      expect(memoryPrompt(store)).not.toContain(`<claim id="${statement.id}"`);
    });
  });

  it('never reaches a model call built from outside content, by recall or read_memory, even for a health pattern', async () => {
    await withStore(async (store, sql) => {
      const { id } = healthNode(store);
      confirmWelcomeNode(store, id, AT);
      const outside = outsideView(store);
      expect(outside.recall('late weekend sleeper sleeps in')).toEqual([]);
      expect(outside.claims().map((claim) => claim.kind)).not.toContain('node_statement');
      expect(outside.statements()).toEqual([]);
      expect(outside.nodes().map((node) => node.id)).not.toContain(id);
      expect(turnMemoryPrompt(outside, 'hi')).not.toContain('Late weekend sleeper');
      const tool = memoryHandlers({ sql, store: outside, conversationRef: 'telegram-1', hideHistory: async () => undefined }).find((candidate) => candidate.name === 'read_memory')!;
      const machine = { authenticatedUserId: 'owner:1', trigger: 'user_message' } as unknown as MemoryToolContext;
      for (const args of [{ query: 'weekend sleeper' }, {}]) expect(JSON.stringify(await tool.handle(tool.schema.parse(args), machine))).not.toContain('Late weekend sleeper');
    });
  });

  it('never counts as evidence for promoting another pattern', async () => {
    await withStore((store) => {
      const { id } = mailNode(store);
      confirmWelcomeNode(store, id, '2026-10-28T04:00:00Z');
      const statement = statements(store)[0]!.id;
      const pattern = owned(store, 'Answers investors first');
      const held: string[] = [];
      applyPromotion(store, JSON.stringify({ nodes: [{ id: null, domain: 'work', label: 'Investor focus', summary: 'Puts investors first', strength: 0.8, status: 'active', supporting_spots: [statement, pattern], durable: true, reason: 'two days' }], edges: [], promoted: [] }), AT,
        (receipt) => { if (receipt.reason) held.push(receipt.reason); });
      expect(held).toEqual(['untrusted_or_missing']);
      expect(store.nodes().map((node) => node.label)).not.toContain('Investor focus');
    });
  });
});

describe('forgetting', () => {
  it('forgetting the statement takes the pattern with it', async () => {
    await withStore((store) => {
      const { id, supports } = mailNode(store);
      for (const support of supports) store.ownerGround(support, AT, 'owner, console');
      confirmWelcomeNode(store, id, AT);
      store.purge([statements(store)[0]!.id], AT);
      expect(store.nodes().map((node) => node.id)).not.toContain(id);
      expect(block(store)).not.toContain('Investor mornings');
    });
  });

  it('forgetting the notes under a confirmed pattern leaves no pattern resting on its own statement', async () => {
    await withStore((store) => {
      const { id, supports } = mailNode(store);
      for (const support of supports) store.ownerGround(support, AT, 'owner, console');
      confirmWelcomeNode(store, id, AT);
      store.purge(supports, AT);
      expect(store.nodes().map((node) => node.id)).not.toContain(id);
      expect(statements(store).filter((claim) => claim.status === 'active')).toEqual([]);
    });
  });

  it('a forget whose words are in a confirmed pattern\'s wording leaves no copy of them, by topic or by id', async () => {
    await withStore((store) => {
      const { id } = mailNode(store);
      confirmWelcomeNode(store, id, AT);
      expect(store.purge([], AT, ['Investor mornings']).ready).toBe(true);
      expect(store.nodes().map((node) => node.id)).not.toContain(id);
      expect(store.allClaims().filter((claim) => claim.text.includes('Investor mornings'))).toEqual([]);
    });
    await withStore((store) => {
      const { id } = mailNode(store);
      confirmWelcomeNode(store, id, AT);
      const said = owned(store, 'Investor mornings');
      expect(store.purge([said], AT).ready).toBe(true);
      expect(store.allClaims().filter((claim) => claim.id !== said && claim.text.includes('Investor mornings'))).toEqual([]);
      expect(statements(store)).toEqual([]);
      expect(confirmation(store, id)).toBe('waldos_read');
    });
  });

  it('forgetting the pattern removes its statement', async () => {
    await withStore((store) => {
      const { id } = mailNode(store);
      confirmWelcomeNode(store, id, AT);
      store.forgetNode(id);
      expect(statements(store)).toEqual([]);
    });
  });
});

describe('patterns already confirmed before this change', () => {
  // What the old confirm left behind: every support grounded, with the marker of the act that grounded it.
  const legacy = (store: ClaimStore, label: string, marks: readonly string[]) => {
    const supports = marks.map((mark, index) => {
      const support = read(store, `${label} note ${index}`, 'gmail');
      store.ownerGround(support, AT, mark);
      return support;
    });
    return store.saveNode({ id: null, domain: 'work', label, summary: `${label} summary`, strength: 0.5, status: 'active', supporting_spots: supports }, AT);
  };

  it('keep confirmed when the owner used the pattern\'s own confirm, and go back to Waldo\'s read when confirmed note by note, once', async () => {
    const name = `node-statement-backfill-${sequence++}`;
    const ids = await withStore((store, sql) => {
      const ids = {
        app: legacy(store, 'App confirmed', ['owner, app:node.confirm', 'owner, app:node.confirm']),
        console: legacy(store, 'Console confirmed', ['owner, console:node.confirm']),
        mixed: legacy(store, 'Mixed confirmed', ['owner, console', 'owner, app:node.confirm']),
        perNote: legacy(store, 'Note by note', ['owner, console', 'owner, console']),
        ownWords: store.saveNode({ id: null, domain: 'work', label: 'Own words confirmed', summary: 'Own words summary', strength: 0.5, status: 'active',
          supporting_spots: [owned(store, 'Own words note')].map((id) => (store.ownerGround(id, AT, 'owner, app:node.confirm'), id)) }, AT),
        ownWordsUnconfirmed: store.saveNode({ id: null, domain: 'work', label: 'Own words only', summary: 'Never confirmed', strength: 0.5, status: 'active', supporting_spots: [owned(store, 'Another own note')] }, AT),
      };
      sql.exec('DROP TABLE IF EXISTS node_statement_backfill');
      return ids;
    }, name);
    await withStore((store) => {
      expect(confirmation(store, ids.app)).toBe('confirmed');
      expect(confirmation(store, ids.console)).toBe('confirmed');
      expect(confirmation(store, ids.mixed)).toBe('confirmed');
      expect(confirmation(store, ids.perNote)).toBe('waldos_read');
      expect(confirmation(store, ids.ownWords)).toBe('confirmed');
      expect(confirmation(store, ids.ownWordsUnconfirmed)).toBe('waldos_read');
      expect(statements(store).map((claim) => claim.source_ref).sort()).toEqual([ids.app, ids.console, ids.mixed, ids.ownWords].map((id) => `node:${id}:backfill:node.confirm`).sort());
    }, name);
    await withStore((store) => expect(statements(store)).toHaveLength(4), name);
  });
});
