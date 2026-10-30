import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { appControlProjectionV1Schema, appControlResultV1Schema, type AppWelcomeBuildV1 } from '../../contracts/src/app/controls';
import { appControlsRequest, type AppControlsHost } from '../src/channels/app-controls';
import type { ConsoleAction } from '../src/channels/console';
import { claimStore } from '../src/memory/claims';

const unused = () => { throw Error('not read here'); };
const building: AppWelcomeBuildV1 = { state: 'building', started_at: 1_761_400_000_000, finished_at: null, nodes: 1, stages: { health: 'done', calendar: 'reading', mail: 'pending', web: 'skipped' } };
const owner = async (run: (storage: DurableObjectStorage) => Promise<void>) => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`welcome-controls-${crypto.randomUUID()}`)), async (_instance, state) => {
    const claims = claimStore(state.storage.sql);
    claims.add({ kind: 'observation', text: 'A weekly Monday planning block recurs.', source: 'inferred', evidence: 'welcome build', origin: 'untrusted', source_ref: 'welcome:calendar:evt_a' }, '2026-10-25T13:00:00Z');
    claims.saveNode({ id: null, domain: 'work', label: 'Monday planning ritual', summary: 'Blocks Monday mornings to plan the week.', strength: 0.5, status: 'active', supporting_spots: [1] }, '2026-10-25T13:00:00Z');
    await run(state.storage);
  });
};
const host = (storage: DurableObjectStorage, acted: ConsoleAction[], signedInAt = new Date().toISOString(), reads: string[] = []): AppControlsHost => ({
  csrf: 'csrf-welcome-controls', expires: Date.now() + 60_000, signedInAt, storage, assertCurrent: async () => {}, sessions: async () => [{ csrf: 'csrf-welcome-controls', expires: Date.now() + 60_000 }],
  view: async () => ({}) as never, act: async (action) => { acted.push(action); return true; },
  welcome: () => { reads.push('welcome'); return building; },
  account: { owner: 'owner-welcome', auth: null, requestUrl: 'https://app.fixture.invalid/app/v1/controls', purgeOwnerFiles: unused, eraseOwnerStorage: unused }, phone: {}, whatsappUnlinked: unused,
});
const read = async (h: AppControlsHost, query: string) => {
  const response = await appControlsRequest(new Request(`https://app.fixture.invalid/app/v1/controls?${query}`), h);
  return appControlProjectionV1Schema.parse(await response.json());
};
const act = async (h: AppControlsHost, body: object) => {
  const response = await appControlsRequest(new Request('https://app.fixture.invalid/app/v1/actions', { method: 'POST', body: JSON.stringify(body) }), h);
  return { status: response.status, body: await response.json() as Record<string, unknown> };
};

it('the summary carries the welcome build, and the node carries its source and Waldo\'s read', async () => {
  await owner(async (storage) => {
    const reads: string[] = [];
    const h = host(storage, [], undefined, reads);
    const summary = await read(h, 'view=constellation');
    expect(summary.view === 'constellation' && summary.data.memory_view === 'summary' && summary.data.welcome).toEqual(building);
    expect(reads).toEqual(['welcome']);
    const nodes = await read(h, 'view=constellation&memory_view=interpretations&limit=10');
    expect(nodes.view === 'constellation' && nodes.data.memory_view === 'interpretations' && nodes.data.items.map((node) => [node.label, node.sources, node.confirmation])).toEqual([['Monday planning ritual', ['calendar'], 'waldos_read']]);
    await read(h, 'view=constellation&memory_view=interpretations&limit=10');
    expect(reads).toEqual(['welcome']);
  });
});

it('node actions run as the console memory action on the node, against that node\'s detail revision', async () => {
  await owner(async (storage) => {
    const acted: ConsoleAction[] = [];
    const h = host(storage, acted);
    const detail = await read(h, 'view=constellation&memory_view=detail&id=memory:node:1');
    const confirmed = await act(h, { view: 'constellation', action: 'node.confirm', id: 'memory:node:1', revision: detail.revision, request_id: 'welcome-confirm-01' });
    expect(confirmed.status).toBe(200);
    expect(appControlResultV1Schema.parse(confirmed.body)).toMatchObject({ request_id: 'welcome-confirm-01', receipt: { state: 'recorded' }, duplicate: false });
    expect(acted).toEqual([{ action: 'node.confirm', id: '1', value: '', made: 'app:node.confirm' }]);
    const replay = await act(h, { view: 'constellation', action: 'node.confirm', id: 'memory:node:1', revision: detail.revision, request_id: 'welcome-confirm-01' });
    expect(replay.body).toMatchObject({ duplicate: true });
    expect(acted).toHaveLength(1);
    const stale = await act(h, { view: 'constellation', action: 'node.forget', id: 'memory:node:1', revision: 'a'.repeat(64), request_id: 'welcome-forget-01' });
    expect([stale.status, stale.body.error]).toEqual([409, 'stale_read']);
    expect(acted).toHaveLength(1);
  });
});

it('a correction is the owner\'s word, so it needs a recent sign-in; confirm and forget do not', async () => {
  await owner(async (storage) => {
    const acted: ConsoleAction[] = [];
    const old = host(storage, acted, new Date(Date.now() - 3 * 3_600_000).toISOString());
    const detail = await read(old, 'view=constellation&memory_view=detail&id=memory:node:1');
    const refused = await act(old, { view: 'constellation', action: 'node.correct', id: 'memory:node:1', value: 'Mondays are for the team', revision: detail.revision, request_id: 'welcome-correct-01' });
    expect([refused.status, refused.body]).toEqual([403, { error: 'step_up_required', code: 'step_up_required' }]);
    expect(acted).toEqual([]);
    const forgotten = await act(old, { view: 'constellation', action: 'node.forget', id: 'memory:node:1', revision: detail.revision, request_id: 'welcome-forget-02' });
    expect(forgotten.status).toBe(200);
    const fresh = host(storage, acted);
    const corrected = await act(fresh, { view: 'constellation', action: 'node.correct', id: 'memory:node:1', value: '  Mondays are for the team ', revision: detail.revision, request_id: 'welcome-correct-02' });
    expect(corrected.status).toBe(200);
    expect(acted).toEqual([{ action: 'node.forget', id: '1', value: '', made: 'app:node.forget' }, { action: 'node.correct', id: '1', value: 'Mondays are for the team', made: 'app:node.correct' }]);
  });
});

it('the setup stage reaches only a build that reads controls revision 5', async () => {
  await owner(async (storage) => {
    const withSetup: AppWelcomeBuildV1 = { ...building, stages: { ...building.stages, setup: 'done' } };
    const h: AppControlsHost = { ...host(storage, []), welcome: () => withSetup };
    const stagesAt = async (contract?: string) => {
      const response = await appControlsRequest(new Request('https://app.fixture.invalid/app/v1/controls?view=constellation', contract ? { headers: { 'x-waldo-app-contract': contract } } : {}), h);
      const summary = appControlProjectionV1Schema.parse(await response.json());
      return summary.view === 'constellation' && summary.data.memory_view === 'summary' ? summary.data.welcome?.stages : undefined;
    };
    for (const older of [undefined, 'controls=2', 'controls=4']) expect(await stagesAt(older)).toEqual(building.stages);
    expect(await stagesAt('controls=5')).toEqual(withSetup.stages);
  });
});
