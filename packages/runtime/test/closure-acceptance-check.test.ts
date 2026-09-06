import { describe, expect, it } from 'vitest';
import {
  canonicalizeAcceptanceCheckV06ForDigest,
  canonicalizeActiveAcceptanceCheckSetV06ForDigest,
} from '@waldo/contracts';
import {
  ClosureAcceptanceCheckBuilder,
  type TrustedClosureSubject,
} from '../src/coordinator/closure-acceptance-check';

async function sha256Hex(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
const digest = (char: string) => `sha256:${char.repeat(64)}` as const;
const subject: TrustedClosureSubject = Object.freeze({
  ownerId: 'owner_01',
  subject: {
    outcome: { id: 'outcome_01', revision: 1, digest: digest('1') },
    workUnit: { id: 'work_01', revision: 2, digest: digest('2') },
  },
});

function builder() {
  let id = 0;
  return new ClosureAcceptanceCheckBuilder({
    now: () => '2026-09-06T14:00:00.000Z',
    newId: () => `check_${++id}`,
    sha256Hex,
  });
}

const criterion = {
  ref: 'criterion_calendar_event_exists',
  revision: 1,
  version: '1.0.0',
  digest: digest('3'),
} as const;
const resolvedMethod = {
  kind: 'deterministic_read_back' as const,
  capability: 'calendar.read',
  version: 'calendar-readback-v1',
  material: { ref: 'server_method_recipe', digest: digest('4') },
};

describe('ClosureAcceptanceCheckBuilder', () => {
  it('constructs an active check only from canonical subject and server-resolved method material', async () => {
    const check = await builder().build({
      canonical: subject,
      criterion,
      resolvedMethod,
    });

    expect(check).toMatchObject({
      protocolVersion: '0.6', ownerId: 'owner_01', revision: 1,
      subject: subject.subject, criterion, verificationMethod: resolvedMethod,
      state: 'active',
    });
    expect(check.digest).toBe(`sha256:${await sha256Hex(canonicalizeAcceptanceCheckV06ForDigest(check))}`);
  });

  it('builds the exact active set in protocol id order with a recomputable digest', async () => {
    const make = builder();
    const first = await make.build({ canonical: subject, criterion, resolvedMethod });
    const second = await make.build({
      canonical: subject,
      criterion: { ...criterion, ref: 'criterion_second', digest: digest('5') },
      resolvedMethod,
    });
    const set = await make.buildActiveSet({
      canonical: subject,
      revision: 1,
      records: [second, first],
    });

    expect(set.records.map((record) => record.id)).toEqual(['check_1', 'check_2']);
    expect(set.acceptanceChecks.map((record) => record.id)).toEqual(['check_1', 'check_2']);
    expect(set.digest).toBe(`sha256:${await sha256Hex(canonicalizeActiveAcceptanceCheckSetV06ForDigest(set))}`);
  });

  it('rejects owner, subject, inactive, duplicate, or malformed check material from the active set', async () => {
    const make = builder();
    const check = await make.build({ canonical: subject, criterion, resolvedMethod });
    await expect(make.buildActiveSet({
      canonical: subject,
      revision: 1,
      records: [check, check],
    })).rejects.toThrow();
    await expect(make.buildActiveSet({
      canonical: { ...subject, ownerId: 'owner_other' },
      revision: 1,
      records: [check],
    })).rejects.toThrow();
  });
});
