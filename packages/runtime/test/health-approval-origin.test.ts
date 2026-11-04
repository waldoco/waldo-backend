import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { appApprovalAtRevision, appApprovalListV1Schema, appApprovalV1Schema, type AppApprovalV1 } from '../../contracts/src/app/approvals';
import { APP_CONTRACT_HEADER } from '../../contracts/src/app/core';
import { appApprovalsRequest } from '../src/channels/app-approvals';
import { approvalDesk } from '../src/channels/approvals';
import { HEALTH_KEEP_ASKING } from '../src/health/trigger';

// Synthetic proposals only. A card the health trigger raised carries the model's one-line reason as its own field, so the
// app can say why Waldo is suggesting it; every other approval reads as it did before.
const NOW = Date.UTC(2026, 9, 10, 9, 0, 0);
const iso = (s: string) => s as never;
const REASON = 'A short night, so a gentler start to the day.';
const CHANGE = { action: 'create' as const, title: 'Focus block', start: iso('2026-10-10T15:00:00Z'), end: iso('2026-10-10T16:00:00Z') };

const withDesk = <T>(name: string, work: (desk: ReturnType<typeof approvalDesk>, state: DurableObjectState) => Promise<T>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`health-approval-origin-${name}`)), async (_instance, state) => {
    let n = 0;
    const desk = approvalDesk(state.storage.sql, { owner: 42, newId: () => `h${++n}`, now: () => NOW, timezone: 'UTC', log: () => {}, appIdentity: () => true, google: async () => null,
      call: async (method: string) => method === 'sendMessage' ? { message_id: 900 + n, chat: { id: 42 } } : true });
    return work(desk, state);
  });

describe('the health origin of an approval', () => {
  it('names the reason on an approval the health trigger raised, and on no other', async () => {
    await withDesk('marks', async desk => {
      const health = await desk.propose({ ...CHANGE, reason: REASON }, undefined, 'health:run-1');
      const ordinary = await desk.propose({ ...CHANGE, title: 'Walk', reason: 'Owner asked' });
      const fromTool = await desk.propose({ ...CHANGE, title: 'Call', reason: 'Owner asked' }, undefined, `tool:${'a'.repeat(64)}`);
      const listed = Object.fromEntries((await desk.approvals(NOW)).map(item => [item.approval_id, item]));
      for (const item of Object.values(listed)) expect(appApprovalV1Schema.safeParse(item).success).toBe(true);
      expect(listed[health]!.health).toEqual({ reason: REASON });
      expect(Object.hasOwn(listed[ordinary]!, 'health')).toBe(false);
      expect(Object.hasOwn(listed[fromTool]!, 'health')).toBe(false);
    });
  });

  it('a health card still lists when its reason carries the question about keeping these coming, up to the longest a proposal holds', async () => {
    await withDesk('long', async desk => {
      const reason = `${'x'.repeat(300 - HEALTH_KEEP_ASKING.length - 1)} ${HEALTH_KEEP_ASKING}`;
      expect(reason).toHaveLength(300);
      const id = await desk.propose({ ...CHANGE, reason }, undefined, 'health:run-2');
      expect((await desk.approvals(NOW, { id }))[0]!.health).toEqual({ reason });
    });
  });

  it('leaves the rest of a health approval as an ordinary one reads, so only the marker is new', async () => {
    await withDesk('rest', async desk => {
      const health = await desk.propose({ ...CHANGE, reason: REASON }, undefined, 'health:run-3');
      const ordinary = await desk.propose({ ...CHANGE, reason: REASON });
      const [marked] = await desk.approvals(NOW, { id: health }), [plain] = await desk.approvals(NOW, { id: ordinary });
      const { health: _marker, approval_id: _a, payload_digest: _d, ...rest } = marked as AppApprovalV1;
      const { approval_id: _b, payload_digest: _e, ...same } = plain as AppApprovalV1;
      expect(rest).toEqual(same);
    });
  });

  it('serves the marker only to a build that reads approvals revision 4, and an older build gets the shape it always had', async () => {
    await withDesk('route', async (desk, state) => {
      const health = await desk.propose({ ...CHANGE, reason: REASON }, undefined, 'health:run-4');
      const ordinary = await desk.propose({ ...CHANGE, title: 'Walk', reason: 'Owner asked' });
      const host = { csrf: 'c', expires: NOW + 3_600_000, storage: state.storage, signedInAt: new Date(NOW).toISOString(), assertCurrent: async () => {}, sessions: async () => [], desk } as never;
      const read = async (header?: string) => appApprovalListV1Schema.parse(await (await appApprovalsRequest(new Request('https://owner.invalid/app/v1/approvals', { headers: header ? { [APP_CONTRACT_HEADER]: header } : {} }), host)).json()).approvals;
      const byId = (items: readonly AppApprovalV1[]) => Object.fromEntries(items.map(item => [item.approval_id, item]));
      const latest = byId(await read('approvals=4'));
      expect(latest[health]!.health).toEqual({ reason: REASON });
      expect(Object.hasOwn(latest[ordinary]!, 'health')).toBe(false);
      for (const header of [undefined, 'approvals=1', 'approvals=2', 'approvals=3']) {
        const older = byId(await read(header));
        expect([header, Object.hasOwn(older[health]!, 'health')]).toEqual([header, false]);
        expect(JSON.stringify(older[health])).toBe(JSON.stringify(appApprovalAtRevision(latest[health]!, header ? Number(header.slice(-1)) : 1)));
      }
    });
  });
});
