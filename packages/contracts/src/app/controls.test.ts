import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { appApprovalReviewV1Schema, appControlProjectionV1Schema, appControlQueryV1Schema, appControlResultV1Schema, appControlViewV1Schema } from './controls';

describe('typed owner control contracts', () => {
  it('publishes a concrete data object for every discriminated view', () => {
    const json = z.toJSONSchema(appControlProjectionV1Schema) as unknown as { oneOf: { properties: { view: { const: string }; data: { type: string; properties?: object; oneOf?: object[]; additionalProperties?: boolean } } }[] };
    expect(json.oneOf.map(branch => branch.properties.view.const)).toEqual(appControlViewV1Schema.options);
    for (const branch of json.oneOf) {
      const data = branch.properties.data;
      if (branch.properties.view.const === 'memory') expect(data.oneOf).toHaveLength(3);
      else { expect(data.type).toBe('object'); expect(data.additionalProperties).toBe(false); expect(Object.keys(data.properties ?? {}).length).toBeGreaterThan(0); }
    }
  });

  it('requires exact operation receipt identity and rejects unknown optimistic success fields', () => {
    const receipt = { request_id: 'owner-change-0001', duplicate: false, receipt: { state: 'unconfirmed', message: 'Outcome remains unconfirmed.' } };
    expect(appControlResultV1Schema.safeParse(receipt).success).toBe(true);
    expect(appControlResultV1Schema.safeParse({ ...receipt, request_id: undefined }).success).toBe(false);
    expect(appControlResultV1Schema.safeParse({ ...receipt, success: true }).success).toBe(false);
  });

  it('accepts only positive Activity cursors and keeps owner selectors out of the query', () => {
    expect(appControlQueryV1Schema.safeParse({ view: 'activity', trace_before: '12', runs_before: '24' }).success).toBe(true);
    for (const query of [{ view: 'activity', trace_before: '0' }, { view: 'activity', trace_before: '9007199254740992' }, { view: 'day', trace_before: '1' }, { view: 'memory', owner: 'foreign' }]) expect(appControlQueryV1Schema.safeParse(query).success).toBe(false);
  });

  it('retains the canonical Google task proposal target and rejects account retargeting', () => {
    const proposal = { args: { source: 'google_tasks', action: 'create', task_list_id: 'list-a', account: 'owner@example.com', changes: { title: 'Actual task' }, reason: 'Owner asked' }, account: { connection_id: 'connection-a', email: 'owner@example.com' }, list: { id: 'list-a', title: 'Actual list', etag: 'version-a' }, before: null };
    const review = { kind: 'google_task_change', account: 'owner@example.com', proposal, proposal_digest: 'a'.repeat(64) };
    expect(appApprovalReviewV1Schema.safeParse(review).success).toBe(true);
    expect(appApprovalReviewV1Schema.safeParse({ ...review, proposal: { ...proposal, account: { ...proposal.account, email: 'foreign@example.com' } } }).success).toBe(false);
  });
});
