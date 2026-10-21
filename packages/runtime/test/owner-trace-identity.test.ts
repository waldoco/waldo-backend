import { describe, expect, it } from 'vitest';
import { enrichOwnerTrace, ownerTraceIdentity, readOwnerTraceHeader, OWNER_TRACE_HEADER } from '../src/observability/owner-trace-identity';

const a = { owner_id: '10000000-0000-0000-0000-00000000000a', owner_email: 'a@test.invalid' };
const b = { owner_id: '10000000-0000-0000-0000-00000000000b', owner_email: 'b@test.invalid' };
const rows = [
  { updateId: 1, doName: 'do-a', subject: '42', traceIdentity: a },
  { updateId: 2, doName: 'do-a', subject: '42', traceIdentity: { ...a, owner_email: 'changed@test.invalid' } },
  { updateId: 3, doName: 'do-b', subject: '43', traceIdentity: b },
];
const entry = (trace: string, hop = 'turn') => ({ trace, hop, ms: 1, ok: true });

describe('verified owner trace identity', () => {
  it('keeps an admitted occurrence identity across a newer email and delayed child hops', () => {
    expect(enrichOwnerTrace(entry('tg-2'), rows, 'do-a', '42')).toMatchObject({ owner_id: a.owner_id, owner_email: 'changed@test.invalid', owner_identity: 'verified' });
    expect(enrichOwnerTrace(entry('tg-1', 'memory'), rows, 'do-a', '42')).toMatchObject({ owner_id: a.owner_id, owner_email: a.owner_email });
    expect(enrichOwnerTrace(entry('tg-3'), rows, 'do-b', '43')).toMatchObject({ owner_id: b.owner_id, owner_email: b.owner_email });
  });

  it('missing, mismatched and non-inbound identities are explicitly unknown; caller guesses cannot override them', () => {
    for (const trace of ['tg-3', 'tg-99', 'machine-1']) {
      expect(enrichOwnerTrace({ ...entry(trace), owner_id: b.owner_id, owner_email: 'chat-guess@test.invalid' }, rows, 'do-a', '42'))
        .toMatchObject({ owner: 'do-a', owner_id: 'unknown', owner_email: 'unknown', owner_identity: 'unknown' });
    }
    expect(enrichOwnerTrace(entry('tg-1'), rows, 'do-a', '99').owner_email).toBe('unknown');
  });

  it('projects only identity fields, rejects malformed headers and never retains credentials', () => {
    const untrustedExtra = { ...a, access_token: 'ACCESS_SECRET', refresh_token: 'REFRESH_SECRET', google_email: 'google@test.invalid' };
    expect(ownerTraceIdentity(untrustedExtra)).toEqual(a);
    const parsed = readOwnerTraceHeader(new Headers({ [OWNER_TRACE_HEADER]: encodeURIComponent(JSON.stringify(untrustedExtra)) }));
    expect(parsed).toEqual(a);
    expect(JSON.stringify(parsed)).not.toMatch(/SECRET|google_email/);
    expect(readOwnerTraceHeader(new Headers({ [OWNER_TRACE_HEADER]: '%zz' }))).toBeUndefined();
    expect(ownerTraceIdentity({ owner_id: 'from-chat', owner_email: a.owner_email })).toBeUndefined();
    expect(ownerTraceIdentity({ owner_id: a.owner_id, owner_email: 'x\r\nAuthorization: SECRET' })).toEqual({ owner_id: a.owner_id, owner_email: null });
  });
});
