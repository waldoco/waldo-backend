import { appControlProjectionV1Schema } from '../../contracts/src/app/controls';
import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { appControlsRequest, type AppControlsHost } from '../src/channels/app-controls';
import { claimStore } from '../src/memory/claims';

const unused = () => { throw Error('The constellation view reads only owner storage'); };
const host = (storage: DurableObjectStorage): AppControlsHost => ({
  csrf: 'csrf-constellation', expires: Date.now() + 60_000, storage, assertCurrent: async () => {}, sessions: unused, view: unused, act: unused,
  account: { owner: 'owner-constellation', auth: null, requestUrl: 'https://app.fixture.invalid/app/v1/controls', purgeOwnerFiles: unused, eraseOwnerStorage: unused },
});
const get = async (storage: DurableObjectStorage, query: string) => {
  const response = await appControlsRequest(new Request(`https://app.fixture.invalid/app/v1/controls?${query}`), host(storage));
  return { status: response.status, body: await response.json() as Record<string, unknown> };
};
const data = (body: Record<string, unknown>) => {
  const parsed = appControlProjectionV1Schema.parse(body);
  if (parsed.view !== 'constellation') throw Error(`unexpected view ${parsed.view}`);
  return parsed.data;
};
const owner = async (seed: (sql: SqlStorage) => void, run: (storage: DurableObjectStorage, doId: string) => Promise<void>) => {
  const stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`app-constellation-${crypto.randomUUID()}`));
  await runInDurableObject(stub, async (_instance, state) => { seed(state.storage.sql); await run(state.storage, state.id.toString()); });
};
const graph = (sql: SqlStorage) => {
  claimStore(sql);
  const claim = (text: string) => sql.exec(`INSERT INTO claims (kind, text, source, evidence, status, created_at, last_seen_at, seen_count, origin, source_ref)
    VALUES ('routine', ?, 'stated', 'Said so on Monday', 'active', '2026-10-01', '2026-10-02', 2, 'owner', 'app:1')`, text);
  claim('Walks after lunch'); claim('Sleeps better after a walk');
  const node = (label: string) => sql.exec(`INSERT INTO constellation_nodes (domain, label, summary, strength, status, first_seen, last_confirmed, supporting_spots)
    VALUES ('work', ?, 'A walk tends to precede a calmer afternoon', 0.6, 'active', '2026-10-01', '2026-10-02', '[1,2]')`, label);
  node('Afternoon reset'); node('Evening wind-down');
  sql.exec("INSERT INTO constellation_edges (from_id, to_id, relation, strength, evidence_count) VALUES (1, 2, 'improves', 0.4, 1)");
};

it('serves every sub-view of the console memory graph under the app contract, without table-local or DO ids', async () => {
  await owner(graph, async (storage, doId) => {
    const summary = await get(storage, 'view=constellation');
    expect(summary.status).toBe(200);
    expect(data(summary.body)).toMatchObject({ memory_view: 'summary', state: 'available', complete: true, counts: { claims: 2, interpretations: 2, associations: 1 } });

    const first = data((await get(storage, 'view=constellation&memory_view=claims&limit=1')).body);
    if (first.memory_view !== 'claims') throw Error('expected claims');
    expect(first.items.map(item => item.text)).toEqual(['Walks after lunch']);
    expect(first.page).toMatchObject({ returned: 1, total: 2 });
    const second = data((await get(storage, `view=constellation&memory_view=claims&limit=1&cursor=${first.page.next_cursor}`)).body);
    if (second.memory_view !== 'claims') throw Error('expected claims');
    expect(second.items.map(item => item.text)).toEqual(['Sleeps better after a walk']);
    expect(second.page.next_cursor).toBeNull();

    const nodes = data((await get(storage, 'view=constellation&memory_view=interpretations&limit=50')).body);
    if (nodes.memory_view !== 'interpretations') throw Error('expected interpretations');
    const [center] = nodes.items;
    expect(center!.support.claim_ids).toEqual(first.items.map(item => item.id).concat(second.items.map(item => item.id)));
    const claimDetail = data((await get(storage, `view=constellation&memory_view=detail&id=${first.items[0]!.id}`)).body);
    expect(claimDetail).toMatchObject({ kind: 'claim', linked_interpretation_ids: nodes.items.map(item => item.id) });
    expect(data((await get(storage, `view=constellation&memory_view=detail&id=${center!.id}`)).body)).toMatchObject({ kind: 'interpretation', support_unavailable_count: 0 });
    const pattern = data((await get(storage, `view=constellation&memory_view=pattern&id=${center!.id}&max_nodes=5&max_links=5`)).body);
    expect(pattern).toMatchObject({ memory_view: 'pattern', showing: { nodes: 1, of_nodes: 1, links: 1, of_links: 1 }, truncated: false });

    const served = JSON.stringify([summary.body, first, second, nodes, claimDetail, pattern]);
    expect(served).not.toContain('local_id');
    expect(served).not.toContain(doId);
  });
});

it('reports an owner with no memory tables as unavailable, and a pending forget as partial with nothing quoted', async () => {
  await owner(() => {}, async storage => {
    const response = await get(storage, 'view=constellation');
    expect(response.status).toBe(200);
    expect(data(response.body)).toMatchObject({ state: 'unavailable', complete: false, counts: { claims: 0, interpretations: 0, associations: 0 } });
  });
  await owner(sql => { graph(sql); sql.exec("INSERT INTO purge_pending (claim_id, fingerprint, created_at) VALUES (1, 'fingerprint', '2026-10-03')"); }, async storage => {
    const claims = await get(storage, 'view=constellation&memory_view=claims&limit=50');
    expect(data(claims.body)).toMatchObject({ state: 'partial', complete: false, items: [] });
    const nodes = await get(storage, 'view=constellation&memory_view=interpretations&limit=50');
    expect(data(nodes.body)).toMatchObject({ state: 'partial', items: [] });
    expect(JSON.stringify([claims.body, nodes.body])).not.toMatch(/walk|Afternoon/i);
  });
});

it('refuses malformed paging and passes the pager errors through', async () => {
  await owner(graph, async storage => {
    for (const query of [
      'view=constellation&limit=51', 'view=constellation&limit=0', 'view=day&memory_view=claims', 'view=constellation&memory_view=graph',
      'view=constellation&limit=5&limit=6', 'view=constellation&owner=other', 'view=constellation&cursor=a%2Fb',
    ]) expect({ query, status: (await get(storage, query)).status }).toEqual({ query, status: 400 });
    expect(await get(storage, 'view=constellation&memory_view=claims')).toEqual({ status: 400, body: { error: 'limit_required' } });
    expect(await get(storage, 'view=constellation&memory_view=claims&limit=5&cursor=bm90LWEtY3Vyc29y')).toEqual({ status: 400, body: { error: 'cursor_invalid' } });
    expect(await get(storage, 'view=constellation&memory_view=detail&id=memory:claim:999')).toEqual({ status: 404, body: { error: 'not_found' } });
    expect(await get(storage, 'view=constellation&memory_view=pattern&id=memory:node:1&max_nodes=5')).toEqual({ status: 400, body: { error: 'max_links_required' } });
  });
});

it('fails closed when the memory read throws', async () => {
  const broken = { sql: { exec: () => { throw Error('storage reset'); } } } as unknown as DurableObjectStorage;
  expect(await get(broken, 'view=constellation')).toEqual({ status: 503, body: { error: 'projection_unavailable' } });
});
