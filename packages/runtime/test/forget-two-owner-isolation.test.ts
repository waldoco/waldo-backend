import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { episodeIndex } from '../src/channels/episodes';
import { claimStore } from '../src/memory/claims';

// Custody is owner-local: the same topic in two owners' stores never crosses. Owner B's incomplete topic and source row stay B's
// when A completes and clears the same topic.
const open = <T>(name: string, run: (sql: SqlStorage, store: ReturnType<typeof claimStore>) => T) =>
  runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name)), (_i, state) => run(state.storage.sql, claimStore(state.storage.sql, work => state.storage.transactionSync(work))));
it('same topic in two owners: clearing one leaves the other incomplete with its source intact', async () => {
  const topic = 'ISO-757-TOPIC', fact = `${topic} likes cobalt paper`, at = '2026-10-05T00:00:00Z';
  await open('iso-owner-b', (sql, store) => { episodeIndex(sql).add('b-src', 'owner', fact, 1); store.beginTopicCoverage(topic, at); });
  await open('iso-owner-a', (sql, store) => {
    episodeIndex(sql).add('a-src', 'owner', fact, 1); store.beginTopicCoverage(topic, at);
    expect(store.incompleteTopics()).toEqual([topic]);
    store.authoriseTopicCoverage(topic, [fact], at);
  });
  await open('iso-owner-b', (sql, store) => {
    expect(store.incompleteTopics()).toEqual([topic]);
    expect(store.forgetSources(topic).sources.map(row => row.text)).toContain(fact);
  });
});
