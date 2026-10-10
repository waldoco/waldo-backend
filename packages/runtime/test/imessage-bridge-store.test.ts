import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { iMessageEventSchema } from '@waldo/contracts';
import { BridgeStore, BridgeStoreError } from '../src/channels/imessage/bridge-store';
import { PROPOSED_LOCAL_TEST_POLICY, type IMessageConnectorPolicy } from '../src/channels/imessage/policy';
import { sha256Hex } from '../src/channels/imessage/crypto';
import { syntheticIMessageCommand, syntheticIMessageEvents } from '../../contracts/src/channels/imessage-v1-fixtures';

const stub = () => env.IMESSAGE_BRIDGE_DO!.get(env.IMESSAGE_BRIDGE_DO!.idFromName(`store-${crypto.randomUUID()}`));
let n = 0;
const h = (atMs = Date.now()) => ({ version: 1 as const, bridgeId: 'fixture-bridge', accountId: 'fixture-account', atMs, nonce: `n-${++n}`, signature: '0'.repeat(64) });
const event = (eventId: string, text = 'Hello', generation = 'fixture-generation') => iMessageEventSchema.parse({ ...syntheticIMessageEvents.text, eventId, text, cursor: { databaseGeneration: generation, value: eventId } });
const commitment = { version: 1 as const, commandDigest: '0'.repeat(64), expiresAtMs: Date.now() + 30_000, signature: '0'.repeat(64) };
const command = async (commandId: string) => { const body = JSON.stringify({ ...syntheticIMessageCommand(), commandId }); return { body, commandDigest: await sha256Hex(body) }; };
const enqueueInput = async (commandId: string) => ({ deliveryId: `d-${commandId}`, ...(await command(commandId)), headers: h(), commitment, ownerDoName: 'owner', replyRef: `reply:${commandId}` });

it('admission is durable across eviction, identical retries share one receipt and changed bytes conflict', async () => {
  const s = stub();
  const body = JSON.stringify(event('e1'));
  await runInDurableObject(s, async (_i, state) => {
    const store = new BridgeStore(state.storage, PROPOSED_LOCAL_TEST_POLICY);
    expect(store.admitEvent(h(), body, await sha256Hex(body), event('e1'))).toEqual({ duplicate: false });
  });
  await evictDurableObject(s);
  await runInDurableObject(s, async (_i, state) => {
    const store = new BridgeStore(state.storage, PROPOSED_LOCAL_TEST_POLICY);
    expect(store.admitEvent(h(), body, await sha256Hex(body), event('e1'))).toEqual({ duplicate: true });
    expect(() => store.admitEvent(h(), 'changed', '1'.repeat(64), event('e1'))).toThrow('event_conflict');
    expect(store.eventCounts().pending).toBe(1);
  });
});

it('parallel admissions of the same identity commit exactly once', async () => {
  const s = stub();
  await runInDurableObject(s, async (_i, state) => {
    const store = new BridgeStore(state.storage, PROPOSED_LOCAL_TEST_POLICY);
    const body = JSON.stringify(event('p1')), digest = await sha256Hex(body);
    const outcomes = await Promise.all(Array.from({ length: 8 }, async () => store.admitEvent(h(), body, digest, event('p1'))));
    expect(outcomes.filter(o => !o.duplicate)).toHaveLength(1);
    expect(store.eventCounts().pending).toBe(1);
  });
});

it('nonce replay is refused inside the same transaction and never advances state', async () => {
  const s = stub();
  await runInDurableObject(s, async (_i, state) => {
    const store = new BridgeStore(state.storage, PROPOSED_LOCAL_TEST_POLICY), headers = h();
    store.heartbeat(headers, 'fixture-generation', 'online');
    expect(() => store.reportCapabilities(headers, {} as never)).toThrow('nonce_replay');
    expect(() => store.heartbeat({ ...h(), atMs: headers.atMs }, 'fixture-generation', 'online')).toThrow('heartbeat_replay');
  });
});

it('generation replacement resets the cursor, drops capabilities, withdraws only never-delivered commands and keeps evidence', async () => {
  const s = stub();
  await runInDurableObject(s, async (_i, state) => {
    const store = new BridgeStore(state.storage, PROPOSED_LOCAL_TEST_POLICY);
    const body = JSON.stringify(event('g1'));
    store.admitEvent(h(), body, await sha256Hex(body), event('g1'));
    const t = Date.now();
    store.heartbeat(h(t), 'fixture-generation', 'online');
    store.enqueue(await enqueueInput('c1'));
    store.heartbeat(h(t + 1), 'generation-2', 'online'); // heartbeat atMs must strictly increase
    expect(store.meta('cursor')).toBeNull();
    expect(store.capabilities('fixture-bridge', 'fixture-account')).toBeNull();
    expect(store.delivery({ commandId: 'c1' })).toMatchObject({ state: 'withdrawn', result: { state: 'rejected', disposition: 'not_started', reason: 'generation_replaced' } });
    expect(store.eventCounts().pending).toBe(1); // old evidence retained
    const next = JSON.stringify(event('g2', 'hi', 'fixture-generation'));
    const nextDigest = await sha256Hex(next);
    expect(() => store.admitEvent(h(), next, nextDigest, event('g2', 'hi', 'fixture-generation'))).toThrow('generation_mismatch');
  });
});

it('pull and withdraw race: whichever commits first wins; a pulled command is never withdrawn', async () => {
  const s = stub();
  await runInDurableObject(s, async (_i, state) => {
    const store = new BridgeStore(state.storage, PROPOSED_LOCAL_TEST_POLICY);
    const row = store.enqueue(await enqueueInput('r1'));
    const [pulled, withdrawn] = await Promise.all([Promise.resolve().then(() => store.pull(h())), Promise.resolve().then(() => store.withdraw(row.deliveryId, 'host_not_pulled'))]);
    expect(pulled?.deliveryId).toBe(row.deliveryId);
    expect(withdrawn).toBe(false);
    expect(store.delivery({ deliveryId: row.deliveryId })).toMatchObject({ state: 'delivered', attempt: 1, result: null });
    // One outstanding command per account; a second reply waits.
    await expect(enqueueInput('r2').then(i => store.enqueue(i))).rejects.toThrow('outstanding_command');
  });
});

it('backpressure rolls the whole step back without evicting pending or uncertain work', async () => {
  const s = stub();
  const tight: IMessageConnectorPolicy = { ...PROPOSED_LOCAL_TEST_POLICY, maxRecords: 6, source: 'test-tight-bounds' };
  await runInDurableObject(s, async (_i, state) => {
    const store = new BridgeStore(state.storage, tight);
    let admitted = 0, refused = 0;
    for (let i = 0; i < 10; i++) {
      const body = JSON.stringify(event(`b${i}`));
      try { store.admitEvent(h(), body, await sha256Hex(body), event(`b${i}`)); admitted++; }
      catch (e) { expect((e as BridgeStoreError).code).toBe('backpressure'); refused++; }
    }
    expect(refused).toBeGreaterThan(0);
    expect(store.eventCounts().pending).toBe(admitted);
    const nonces = state.storage.sql.exec('SELECT count(*) AS c FROM nonces').one().c;
    expect(Number(nonces)).toBe(admitted); // refused steps consumed no nonce
  });
});

it('a quarantined lane survives eviction and rejects new replies; a late result cannot clear it', async () => {
  const s = stub();
  await runInDurableObject(s, async (_i, state) => {
    const store = new BridgeStore(state.storage, { ...PROPOSED_LOCAL_TEST_POLICY, mutationDeadlineMs: 2, deliveryDeadlineMs: 1, commitmentMaxAgeMs: 1, source: 'test-fast-deadlines' });
    const row = store.enqueue(await enqueueInput('q1'));
    store.pull(h());
    await new Promise(r => setTimeout(r, 5));
    store.sweepDeadlines();
    expect(store.delivery({ deliveryId: row.deliveryId })?.result).toMatchObject({ state: 'unknown', disposition: 'still_in_flight' });
    expect(store.quarantined()).toBe(true);
  });
  await evictDurableObject(s);
  await runInDurableObject(s, async (_i, state) => {
    const store = new BridgeStore(state.storage, PROPOSED_LOCAL_TEST_POLICY);
    expect(store.quarantineReason()).toBe('mutation_deadline');
    await expect(enqueueInput('q2').then(i => store.enqueue(i))).rejects.toThrow('lane_quarantined');
  });
});

it('handed and acknowledged events keep only identity and digest; held evidence keeps its body', async () => {
  const s = stub();
  await runInDurableObject(s, async (_i, state) => {
    const store = new BridgeStore(state.storage, PROPOSED_LOCAL_TEST_POLICY);
    for (const id of ['k1', 'k2']) { const body = JSON.stringify(event(id, `private ${id}`)); store.admitEvent(h(), body, await sha256Hex(body), event(id, `private ${id}`)); }
    store.settleEvent(store.nextPendingEvent()!.seq, 'handed', 'handed');
    store.settleEvent(store.nextPendingEvent()!.seq, 'held', 'media_unsupported');
    const rows = state.storage.sql.exec('SELECT event_id, body, digest FROM events ORDER BY seq').toArray() as { event_id: string; body: string; digest: string }[];
    expect(rows[0]).toMatchObject({ event_id: 'k1', body: '' });
    expect(rows[1]!.body).toContain('private k2');
    const again = JSON.stringify(event('k1', 'private k1'));
    expect(store.admitEvent(h(), again, await sha256Hex(again), event('k1', 'private k1'))).toEqual({ duplicate: true }); // dedup still works
  });
});
