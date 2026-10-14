import { describe, expect, it } from 'vitest';
import { ClosedRunError, type RunEffectScope } from '../src/channels/run-effect-scope';
import { OwnerAdmissionError } from '../src/identity/owner-message-admission';
import { surfaceOwnerAdmission, type SurfaceOwnerBinding } from '../src/identity/surface-owner-admission';

const DO_ID = 'physical-do-1';
const BINDING: SurfaceOwnerBinding = { ownerId: '5d1f8a20-6c3b-4e9a-b7d2-0e4f6a8c1b3d', bindingRef: 'session-a', revision: '1', physicalDoId: DO_ID };

const harness = () => {
  let clock = 1_000_000;
  let closed = false;
  let answer: () => Promise<SurfaceOwnerBinding> = async () => BINDING;
  let reads = 0;
  const scope: RunEffectScope = { runId: 'run', attempt: 'attempt', deadline: Infinity, signal: new AbortController().signal,
    admit: () => { if (closed) throw new ClosedRunError(); }, commit: work => work() };
  const admit = () => surfaceOwnerAdmission({ scope, lookup: () => { reads += 1; return answer(); }, expectedPhysicalDoId: DO_ID, surface: 'app',
    subject: 'subject', occurrenceKey: 'occurrence', occurredAt: clock - 1, text: 'hello', now: () => clock });
  return {
    admit,
    reads: () => reads,
    advance: (ms: number) => { clock += ms; },
    close: () => { closed = true; },
    answer: (next: () => Promise<SurfaceOwnerBinding>) => { answer = next; },
  };
};

describe('surface owner admission: authority re-reads', () => {
  it('admission reads the directory twice, as before', async () => {
    const h = harness();
    await h.admit();
    expect(h.reads()).toBe(2);
  });

  it('checks inside the verified window reuse the last read', async () => {
    const h = harness();
    const admission = await h.admit();
    const afterAdmission = h.reads();
    for (let i = 0; i < 40; i += 1) await admission.assertCurrent();
    await admission.readInput();
    expect(h.reads()).toBe(afterAdmission);
  });

  it('a check after the window reads again and sees a revoked session', async () => {
    const h = harness();
    const admission = await h.admit();
    h.answer(async () => ({ ...BINDING, revision: '2' }));
    await admission.assertCurrent();
    h.advance(1_000);
    await expect(admission.assertCurrent()).rejects.toEqual(new OwnerAdmissionError('rejected'));
  });

  it('a directory outage after the window is unavailable, and the next check reads again', async () => {
    const h = harness();
    const admission = await h.admit();
    h.advance(1_000);
    h.answer(async () => { throw new Error('directory down'); });
    await expect(admission.assertCurrent()).rejects.toEqual(new OwnerAdmissionError('unavailable'));
    const before = h.reads();
    h.answer(async () => BINDING);
    await admission.assertCurrent();
    expect(h.reads()).toBe(before + 1);
  });

  it('a closed run fails every check, cached or not', async () => {
    const h = harness();
    const admission = await h.admit();
    h.close();
    const before = h.reads();
    await expect(admission.assertCurrent()).rejects.toBeInstanceOf(ClosedRunError);
    await expect(admission.readInput()).rejects.toBeInstanceOf(ClosedRunError);
    expect(h.reads()).toBe(before);
  });

  it('concurrent checks after the window share one read', async () => {
    const h = harness();
    const admission = await h.admit();
    h.advance(1_000);
    const before = h.reads();
    await Promise.all([admission.assertCurrent(), admission.assertCurrent(), admission.assertCurrent()]);
    expect(h.reads()).toBe(before + 1);
  });

  it('the window counts from when the read started, not when it returned', async () => {
    const h = harness();
    const admission = await h.admit();
    h.advance(1_000);
    h.answer(async () => { h.advance(900); return BINDING; });
    await admission.assertCurrent();
    const before = h.reads();
    h.advance(100);
    await admission.assertCurrent();
    expect(h.reads()).toBe(before + 1);
  });

  it('a fresh check reads inside the window and sees a revocation the cached check would miss', async () => {
    const h = harness();
    const admission = await h.admit();
    h.answer(async () => ({ ...BINDING, revision: '2' }));
    await admission.assertCurrent();
    await expect(admission.assertFresh!()).rejects.toEqual(new OwnerAdmissionError('rejected'));
  });

  it('concurrent fresh checks share one read, and a closed run fails one without reading', async () => {
    const h = harness();
    const admission = await h.admit();
    const before = h.reads();
    await Promise.all([admission.assertFresh!(), admission.assertFresh!(), admission.assertCurrent()]);
    expect(h.reads()).toBe(before + 1);
    h.close();
    await expect(admission.assertFresh!()).rejects.toBeInstanceOf(ClosedRunError);
    expect(h.reads()).toBe(before + 1);
  });
});
