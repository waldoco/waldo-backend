import { describe, expect, it, vi } from 'vitest';
import { appProtectedResponses, type AppProtectedResponseBinding } from '../src/channels/app-protected-response';
import { appMessageV1Schema } from '../../contracts/src/app/core';

const binding: AppProtectedResponseBinding = { principal_ref: `prn_${'a'.repeat(32)}`, session_ref: `sess_${'b'.repeat(64)}`, conversation_ref: 'owner:canonical:thread:main' };
const readRequest = (metadata: { part: { readback_path: string } }) => new Request(`https://waldo.test${metadata.part.readback_path}`);
const protectedReply = (assertCurrent = async () => {}) => ({ text: 'Synthetic owner sleep: 420 minutes; preserve the fixed meeting and add a recovery break.', custody: { kind: 'volatile_owner_health' as const, assertHealthCurrent: async () => {}, assertCurrent } });

describe('protected app response custody', () => {
  it('publishes metadata only and supplies actual useful owner readback through independent authority', async () => {
    let now = 100, executionActive = true; const deliveryCurrent = vi.fn(async () => {});
    const book = appProtectedResponses({ now: () => now });
    const metadata = await book.register(protectedReply(async () => { if (!executionActive) throw new Error('execution closed'); }), binding, deliveryCurrent);
    expect(metadata.expires_at).toBe(300100);
    expect(JSON.stringify(metadata)).not.toContain('420 minutes');
    expect(appMessageV1Schema.parse({ id: 'protected', role: 'assistant', text: '', parts: [metadata.part], channel: 'app', parent_id: 'owner-turn' }).parts[0]).toEqual(metadata.part);
    executionActive = false; now = 200;
    const result = await book.readback(readRequest(metadata), binding, async () => {});
    expect(result!.status).toBe(200); expect(result!.headers.get('cache-control')).toBe('private, no-store');
    expect(await result!.json()).toMatchObject({ state: 'available', text: protectedReply().text, retention: 'volatile', conversation_ref: binding.conversation_ref });
    expect(deliveryCurrent.mock.calls.length).toBeGreaterThanOrEqual(4);
  });
  it('cross-owner, wrong-session and wrong-conversation readbacks never expose text', async () => {
    const book = appProtectedResponses(), metadata = await book.register(protectedReply(), binding, async () => {});
    for (const other of [{ ...binding, principal_ref: `prn_${'c'.repeat(32)}` }, { ...binding, session_ref: `sess_${'c'.repeat(64)}` }, { ...binding, conversation_ref: 'owner:other:thread:main' }]) {
      const result = await book.readback(readRequest(metadata), other, async () => {});
      expect(result!.status).toBe(403); expect(await result!.text()).not.toContain('420 minutes');
    }
  });
  it('health withdrawal and session revocation after registration delete volatile content', async () => {
    let revoked = false; const book = appProtectedResponses();
    const metadata = await book.register(protectedReply(), binding, async () => { if (revoked) throw new Error('Synthetic private error 420 minutes'); });
    revoked = true;
    const result = await book.readback(readRequest(metadata), binding, async () => {});
    expect(result!.status).toBe(410); expect(await result!.text()).not.toContain('420 minutes');
    revoked = false; expect((await book.readback(readRequest(metadata), binding, async () => {}))!.status).toBe(410);
    const next = await book.register(protectedReply(), binding, async () => {});
    book.revokeSession(binding.principal_ref, binding.session_ref);
    expect((await book.readback(readRequest(next), binding, async () => {}))!.status).toBe(410);
  });
  it('restart and expiry truthfully report gone content instead of a fabricated delivered reply', async () => {
    let now = 100; const book = appProtectedResponses({ now: () => now, ttlMs: 999999 });
    const metadata = await book.register(protectedReply(), binding, async () => {});
    expect(metadata.expires_at).toBe(300100);
    expect((await appProtectedResponses().readback(readRequest(metadata), binding, async () => {}))!.status).toBe(410);
    now = metadata.expires_at; expect((await book.readback(readRequest(metadata), binding, async () => {}))!.status).toBe(410);
  });
  it('a revoke during registration never publishes a response reference', async () => {
    const book = appProtectedResponses(); let checks = 0;
    await expect(book.register(protectedReply(async () => { if (++checks > 1) throw new Error('revoked'); }), binding, async () => {})).rejects.toThrow('authority changed');
  });
  it('rechecks post-await authority immediately before returning the body and keeps errors generic', async () => {
    const book = appProtectedResponses(); let deliveryChecks = 0, requestChecks = 0;
    const metadata = await book.register(protectedReply(), binding, async () => { if (++deliveryChecks >= 4) throw new Error('Synthetic private 420 minutes'); });
    const result = await book.readback(readRequest(metadata), binding, async () => { requestChecks++; });
    expect(result!.status).toBe(410); expect(await result!.text()).not.toContain('420 minutes'); expect(requestChecks).toBeGreaterThanOrEqual(2);
  });
  it('erasing a topic removes only its protected responses and capacity never evicts unexpired work', async () => {
    const book = appProtectedResponses({ capacity: 2 });
    const main = await book.register(protectedReply(), binding, async () => {});
    const sideBinding = { ...binding, conversation_ref: 'owner:canonical:thread:side' };
    const side = await book.register(protectedReply(), sideBinding, async () => {});
    await expect(book.register(protectedReply(), binding, async () => {})).rejects.toThrow('capacity');
    book.eraseConversation(binding.principal_ref, binding.conversation_ref);
    expect((await book.readback(readRequest(main), binding, async () => {}))!.status).toBe(410);
    expect((await book.readback(readRequest(side), sideBinding, async () => {}))!.status).toBe(200);
  });
});
