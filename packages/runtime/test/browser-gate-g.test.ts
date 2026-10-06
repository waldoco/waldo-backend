import { describe, expect, it } from 'vitest';
import { browserGate } from '../src/channels/browser-gate';
import type { BrowserGateCommand } from '../src/channels/browser-gate-types';
import { harness, OWNER } from './fixtures/browser-gate-fake-site';

// Red-first gate tests for browser S2 (spec r2, G1-G16, H1-H4). Written by Core against Dalda's stub.
// Each test names its gate id. Layer: SOURCE with an in-memory fake site; no real browser.
const setup = () => { const h = harness(); return { ...h, gate: browserGate(h.options) }; };
const click = (element_ref: string, intent?: 'read' | 'send'): BrowserGateCommand => ({ operation: 'click', element_ref, ...(intent ? { intent } : {}) });
// A refusal must be a real refusal: the throwing stub must not satisfy it.
const refused = async (work: Promise<unknown>) => { const error = await work.then(() => null, (e: unknown) => e as Error); expect(error, 'expected a refusal').not.toBeNull(); expect(String(error?.message)).not.toMatch(/not implemented/); };
const heldOf = (r: Awaited<ReturnType<ReturnType<typeof browserGate>['command']>>) => { if (!r.held) throw Error('expected a hold'); return r; };

describe('browser gate: what runs and what holds', () => {
  it('G1 a plain link and a type=button run with no approval; navigation is GET only', async () => {
    const t = setup();
    expect((await t.gate.command(OWNER, click('feedback-link'))).held).toBe(false);
    expect((await t.gate.command(OWNER, click('plain-button'))).held).toBe(false);
    expect(t.site.posts()).toEqual([]);
    expect(t.site.gets().length).toBeGreaterThan(0);
  });
  it('G2 a submit control is held with a digest; nothing is posted', async () => {
    for (const ref of ['send-submit', 'send-untyped']) {
      const t = setup();
      const held = heldOf(await t.gate.command(OWNER, click(ref)));
      expect(held.proposal.actionDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(held.approvalRef).toBeTruthy();
      expect(t.site.requests.filter((r) => r.method !== 'GET')).toEqual([]);
    }
  });
  it('G3 Enter in a field that would submit is held like a submit click', async () => {
    const t = setup();
    heldOf(await t.gate.command(OWNER, { operation: 'type', element_ref: 'name', key: 'Enter' }));
    expect(t.site.requests.filter((r) => r.method !== 'GET')).toEqual([]);
  });
  it('G4 the control type decides, not its label: a submit labelled anything is held, a link labelled "Send us feedback" is not', async () => {
    const t = setup();
    expect((await t.gate.command(OWNER, click('feedback-link'))).held).toBe(false);
    heldOf(await t.gate.command(OWNER, click('send-submit')));
  });
  it('G5 a declared send never becomes an unrelated submit; a declared read never relaxes a native submit', async () => {
    const a = setup();
    // Seam delta (Dalda 11:55): reason 'declared_send_unsupported', no proposal, no card, no effect.
    const r = await a.gate.command(OWNER, click('plain-button', 'send')) as unknown as { held: boolean; reason?: string; proposal?: unknown; approvalRef?: unknown };
    expect(r.held).toBe(true); expect(r.reason).toBe('declared_send_unsupported');
    expect(r.proposal).toBeUndefined(); expect(r.approvalRef).toBeUndefined();
    expect(a.site.requests.filter((x) => x.method !== 'GET')).toEqual([]);
    expect(a.approvals.open.size).toBe(0);
    const b = setup();
    heldOf(await b.gate.command(OWNER, click('send-submit', 'read')));
  });
  it('G6 a page script POST from a non-form button is aborted and the run reports a hold', async () => {
    const t = setup();
    const result = await t.gate.command(OWNER, click('script-post-button'));
    expect(t.site.posts()).toEqual([]);          // 0 write requests reached the fake server
    expect(t.site.blockedWrites()).toHaveLength(1); // the write was attempted and aborted by the host
    expect(result.held).toBe(true);
  });
  it('G7 the approval card comes from host-observed facts, not the model text', async () => {
    const t = setup();
    await t.gate.command(OWNER, { operation: 'type', element_ref: 'name', value: 'Ada' });
    const held = heldOf(await t.gate.command(OWNER, { ...click('send-submit'), description: 'just reading, nothing sent' } as unknown as BrowserGateCommand));
    expect(JSON.stringify(held.proposal)).toContain('site.example/submit');
    expect(JSON.stringify(held.proposal)).not.toContain('just reading');
  });
});

describe('browser gate: deny, approve, replay, binding', () => {
  it('G8 deny sends nothing and the session stays usable', async () => {
    const t = setup();
    const held = heldOf(await t.gate.command(OWNER, click('send-submit')));
    await t.gate.deny(OWNER, held.proposal.id);
    expect(t.site.posts()).toEqual([]);
    expect(t.isAlive()).toBe(true);
    expect((await t.gate.command(OWNER, click('feedback-link'))).held).toBe(false);
  });
  it('G9 approve with the matching ref posts exactly once; a second approve is refused; a changed page is refused as stale', async () => {
    const t = setup();
    const held = heldOf(await t.gate.command(OWNER, click('send-submit')));
    await t.gate.approve(OWNER, held.proposal.id, held.approvalRef);
    expect(t.site.posts()).toHaveLength(1);
    await refused(t.gate.approve(OWNER, held.proposal.id, held.approvalRef));
    expect(t.site.posts()).toHaveLength(1);
    const s = setup();
    const h2 = heldOf(await s.gate.command(OWNER, click('send-submit')));
    s.site.values.name = 'changed after the hold';
    await refused(s.gate.approve(OWNER, h2.proposal.id, h2.approvalRef));
    expect(s.site.posts()).toEqual([]);
  });
  it('G10 another owner cannot approve or deny', async () => {
    const t = setup();
    const held = heldOf(await t.gate.command(OWNER, click('send-submit')));
    await refused(t.gate.approve('owner-2', held.proposal.id, held.approvalRef));
    await refused(t.gate.deny('owner-2', held.proposal.id));
    expect(t.site.posts()).toEqual([]);
  });
  it('G10b a wrong or foreign approval ref is refused', async () => {
    const t = setup();
    const held = heldOf(await t.gate.command(OWNER, click('send-submit')));
    await refused(t.gate.approve(OWNER, held.proposal.id, 'approval-999'));
    expect(t.site.posts()).toEqual([]);
  });
});

describe('browser gate: closed command set and navigation', () => {
  it('G11 commands outside the closed set are rejected (script, storage, session id)', async () => {
    const t = setup();
    for (const bad of [{ operation: 'evaluate', script: 'document.cookie' }, { operation: 'cookies' }, { operation: 'goto', url: 'https://site.example/x', session_id: 'sess-9' }, { operation: 'storage' }]) {
      await refused(t.gate.command(OWNER, bad as never));
    }
    expect(t.site.requests).toEqual([]);
  });
  it('G12 goto off the allowed origin is rejected before any request', async () => {
    const t = setup();
    await refused(t.gate.command(OWNER, { operation: 'goto', url: 'https://evil.example/' }));
    expect(t.site.requests).toEqual([]);
  });
  it('G13 the snapshot returned to the model has text and refs only, no values or secrets', async () => {
    const t = setup();
    t.site.values.name = 'Ada Lovelace';
    const result = await t.gate.command(OWNER, { operation: 'read' });
    if (result.held) throw Error('read must not hold');
    expect(JSON.stringify(result.snapshot)).not.toContain('Ada Lovelace');
  });
  it('G15 typing into a password input is refused', async () => {
    const t = setup();
    await refused(t.gate.command(OWNER, { operation: 'type', element_ref: 'password', value: 'hunter2' }));
    expect(t.site.values.password).toBeUndefined();
  });
  it('G16 a same-host GET link such as /items/delete?id=1 is treated as a read; the gate makes no claim it was safe', async () => {
    const t = setup();
    const result = await t.gate.command(OWNER, click('delete-link'));
    expect(result.held).toBe(false);                       // the host cannot know a GET has effects
    expect(t.site.gets().some((r) => r.url.endsWith('/items/delete?id=1'))).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/safe|read-only|no changes/i);
  });
});

describe('browser gate: seam delta from the 11:55 review', () => {
  it('G17 an image submit control is held before any effect', async () => {
    const t = setup();
    t.site.addElement({ ref: 'image-submit', tag: 'input', type: 'image', inForm: true });
    heldOf(await t.gate.command(OWNER, click('image-submit')));
    expect(t.site.requests.filter((r) => r.method !== 'GET')).toEqual([]);
  });
  it('G18 an approval that expires between the check and the execute does not post', async () => {
    const t = setup();
    const held = heldOf(await t.gate.command(OWNER, click('send-submit')));
    t.site.beforeEffect(() => { t.clock.now += 11 * 60 * 1000; });   // the clock passes expiry inside the final await
    await refused(t.gate.approve(OWNER, held.proposal.id, held.approvalRef));
    expect(t.site.posts()).toEqual([]);
  });
});

describe('browser gate: request permit (fake request broker, not live firewall proof)', () => {
  it('G19 one approval permits exactly one matching request', async () => {
    const t = setup();
    const held = heldOf(await t.gate.command(OWNER, click('send-submit')));
    t.site.setAllow((r) => r.method === 'GET' || r.url === `${t.site.origin}/submit`);
    await t.gate.approve(OWNER, held.proposal.id, held.approvalRef);
    expect(t.site.posts()).toHaveLength(1);
    heldOf(await t.gate.command(OWNER, click('send-submit')));        // the same request again needs a new approval
    expect(t.site.posts()).toHaveLength(1);
  });
  it('G20 a redirect from an allowed GET to a write target is aborted', async () => {
    const t = setup();
    t.site.addRedirect(`${t.site.origin}/feedback`, `${t.site.origin}/api/side-effect`);
    t.site.setAllow((r) => r.method === 'GET');
    await t.gate.command(OWNER, { operation: 'goto', url: `${t.site.origin}/feedback` }).catch(() => undefined);
    expect(t.site.blockedWrites()).toHaveLength(1);   // the redirect hop was attempted and refused by the host
    expect(t.site.posts()).toEqual([]);
  });
  it('G21 Enter in a text field is a native submit and is held', async () => {
    const t = setup();
    heldOf(await t.gate.command(OWNER, { operation: 'type', element_ref: 'name', value: 'x', key: 'Enter' } as BrowserGateCommand));
    expect(t.site.posts()).toEqual([]);
  });
});

describe('browser gate: session lifecycle', () => {
  it('G14 finishing the run closes the session and reads back absence; a time limit stops the loop with an error', async () => {
    const t = setup();
    await t.gate.command(OWNER, { operation: 'read' });
    await t.gate.finishRun(OWNER);
    expect(t.isAlive()).toBe(false);
    expect(t.sessions.closed).toEqual(['sess-1']);
    const late = setup();
    await late.gate.command(OWNER, { operation: 'read' });
    late.clock.now += 24 * 60 * 60 * 1000;
    await refused(late.gate.command(OWNER, { operation: 'read' }));
    expect(late.isAlive()).toBe(false);
  });
  it('H1 a hold keeps the session alive for the approval window', async () => {
    const t = setup();
    heldOf(await t.gate.command(OWNER, click('send-submit')));
    expect(t.isAlive()).toBe(true);
    expect(t.sessions.closed).toEqual([]);
  });
  it('H2 expiry closes the session with absence readback and refuses a late approve', async () => {
    const t = setup();
    const held = heldOf(await t.gate.command(OWNER, click('send-submit')));
    t.clock.now += 11 * 60 * 1000;
    await t.gate.expire(OWNER);
    expect(t.isAlive()).toBe(false);
    await refused(t.gate.approve(OWNER, held.proposal.id, held.approvalRef));
    expect(t.site.posts()).toEqual([]);
  });
  it('H3 deny then run end closes the session', async () => {
    const t = setup();
    const held = heldOf(await t.gate.command(OWNER, click('send-submit')));
    await t.gate.deny(OWNER, held.proposal.id);
    await t.gate.finishRun(OWNER);
    expect(t.isAlive()).toBe(false);
  });
  it('H4 a second hold in the same run does not extend the first approval window', async () => {
    const t = setup();
    const first = heldOf(await t.gate.command(OWNER, click('send-submit')));
    t.clock.now += 6 * 60 * 1000;
    heldOf(await t.gate.command(OWNER, click('send-untyped')));
    t.clock.now += 5 * 60 * 1000;                               // past the first window, inside a fresh one
    await t.gate.expire(OWNER);
    await refused(t.gate.approve(OWNER, first.proposal.id, first.approvalRef));
    expect(t.isAlive()).toBe(false);
  });
});
