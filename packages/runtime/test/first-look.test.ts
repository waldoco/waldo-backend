import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { FIRST_LOOK_MAX, firstLookDecisions, firstLookInput, lookQueue, settleLook } from '../src/channels/first-look';
import { updateBook } from '../src/channels/update-cards';
import { webhookChange, webhookChanges } from '../src/channels/webhook-changes';

// FIRST_LOOK: a cheap first look judges each queued webhook before any full run. Code holds what each decision does and
// that an unread look wakes; the model judges. Every notice is synthetic.
const PR = { kind: 'pull_request.opened', title: 'Fix the invoice export', url: 'https://code.example/pr/7' };
const change = (id: string) => webhookChange('github', id, PR);
let seq = 0;
const withStore = (work: (storage: DurableObjectStorage) => Promise<void> | void) =>
  runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(`first-look-${seq += 1}`)), async (_instance, state) => { await work(state.storage); });

describe('the first look\'s answer', () => {
  const refs = ['webhook:github:a', 'webhook:github:b', 'webhook:github:c'];
  it('golden: each event takes the decision the look gave it', () => {
    const raw = JSON.stringify({ looks: [{ ref: refs[0], reason: 'deadline moved', decision: 'wake' }, { ref: refs[1], reason: 'fyi', decision: 'next_card' }, { ref: refs[2], reason: 'bot noise', decision: 'ignore' }] });
    expect([...firstLookDecisions(raw, refs)]).toEqual([[refs[0], 'wake'], [refs[1], 'next_card'], [refs[2], 'ignore']]);
  });

  it('fails open: an unread, unparseable or partial look wakes what it did not settle', () => {
    expect([...firstLookDecisions(null, refs).values()]).toEqual(['wake', 'wake', 'wake']);
    expect([...firstLookDecisions('not json', refs).values()]).toEqual(['wake', 'wake', 'wake']);
    expect([...firstLookDecisions(JSON.stringify({ looks: [{ ref: refs[2], reason: 'x', decision: 'ignore' }] }), refs).values()]).toEqual(['wake', 'wake', 'ignore']);
    expect(firstLookDecisions(JSON.stringify({ looks: [{ ref: refs[0], reason: 'x', decision: 'later' }] }), refs).get(refs[0])).toBe('wake');
  });

  it('an event named twice two ways wakes; a ref it was not given is left out', () => {
    const raw = JSON.stringify({ looks: [{ ref: refs[0], reason: 'x', decision: 'ignore' }, { ref: refs[0], reason: 'y', decision: 'next_card' }, { ref: 'webhook:other:z', reason: 'x', decision: 'ignore' }] });
    const decided = firstLookDecisions(raw, refs);
    expect(decided.get(refs[0])).toBe('wake');
    expect(decided.has('webhook:other:z')).toBe(false);
  });

  it('the notices sit in their own fence, apart from what Waldo watches and the owner\'s day', () => {
    const input = firstLookInput([change('a')], '', '');
    expect(input).toMatch(/<notices>\n- \[webhook:github:a\]/);
    expect(input).toContain('<watching>\nNothing.');
  });
});

describe('committing a look', () => {
  it('golden: woken events join the sweep\'s queue, the next card\'s become an update record, ignored ones go, and the look\'s queue empties', async () => withStore(storage => {
    const looks = lookQueue(storage.kv), updates = updateBook(storage.sql);
    const events = [change('a'), change('b'), change('c')];
    for (const event of events) looks.add(event);
    const took = storage.transactionSync(() => settleLook({ looks, wake: event => { webhookChanges(storage.kv).add(event); }, nextCard: later => { updates.record('2030-03-04', 1, later, null); } },
      looks.pending(), new Map([[events[0]!.ref!, 'wake'], [events[1]!.ref!, 'next_card'], [events[2]!.ref!, 'ignore']])));
    expect(took).toEqual({ wake: 1, next_card: 1, ignore: 1 });
    expect(webhookChanges(storage.kv).take().map(event => event.ref)).toEqual([events[0]!.ref]);
    expect(updates.unfoldedWebhook()).toBe(true);
    expect(looks.pending()).toEqual([]);
  }));

  it('a look that overlapped another settles only what is still waiting', async () => withStore(storage => {
    const looks = lookQueue(storage.kv);
    const events = [change('a'), change('b')];
    for (const event of events) looks.add(event);
    const seen = looks.pending();
    looks.settle([events[0]!.ref!]);
    let woken = 0;
    const took = settleLook({ looks, wake: () => { woken += 1; }, nextCard: () => undefined }, seen, new Map(events.map(event => [event.ref!, 'wake'])));
    expect([took.wake, woken]).toEqual([1, 1]);
  }));

  it('the queue is bounded and a look cut off leaves its events for the next', async () => withStore(storage => {
    const looks = lookQueue(storage.kv);
    for (let i = 0; i < FIRST_LOOK_MAX; i += 1) expect(looks.add(change(`e${i}`))).toBe(0);
    expect(looks.add(change('last'))).toBe(1);
    expect(looks.pending()).toHaveLength(FIRST_LOOK_MAX);
    expect(looks.pending()).toHaveLength(FIRST_LOOK_MAX);
  }));
});
