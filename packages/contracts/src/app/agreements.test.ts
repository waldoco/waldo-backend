import { describe, expect, it } from 'vitest';
import { APP_CONTROLS_AGENT_MAIL_REVISION, APP_CONTROLS_AGREEMENTS_REVISION, APP_CONTROLS_CLAIM_CONTROLS_REVISION, APP_IMPROVE_WALDO_AGREEMENT_V1, APP_IMPROVE_WALDO_RECEIPTS_V1, appControlActionV1Schema, appControlProjectionV1Schema, appControlQueryV1Schema, appControlReceiptV1Schema } from './controls';

const revision = 'f'.repeat(64);
const improve = { view: 'agreements', action: 'improve_waldo.set', value: 'given', notice: APP_IMPROVE_WALDO_AGREEMENT_V1.version, revision, request_id: 'agree-0001' };
const view = (data: object) => ({ version: 1, state: 'available', revision, view: 'agreements', data });
const data = { improve_waldo: { given: false, version: APP_IMPROVE_WALDO_AGREEMENT_V1.version, changed_at: null }, actions: ['improve_waldo.set'] };

describe('the agreements view', () => {
  it('comes at revision 18, after the earlier controls revisions', () => {
    expect(APP_CONTROLS_AGREEMENTS_REVISION).toBe(18);
    expect(APP_CONTROLS_AGREEMENTS_REVISION).toBeGreaterThan(Math.max(APP_CONTROLS_CLAIM_CONTROLS_REVISION, APP_CONTROLS_AGENT_MAIL_REVISION));
  });

  it('is a view the app may ask for, carrying the agreement and its one action', () => {
    expect(appControlQueryV1Schema.safeParse({ view: 'agreements' }).success).toBe(true);
    expect(appControlProjectionV1Schema.safeParse(view(data)).success).toBe(true);
    expect(appControlProjectionV1Schema.safeParse(view({ ...data, improve_waldo: { given: true, version: '2026-11-06', changed_at: 1_762_400_000_000 } })).success).toBe(true);
    for (const bad of [{ ...data, actions: ['agent_mail.claim'] }, { ...data, improve_waldo: { given: false, version: APP_IMPROVE_WALDO_AGREEMENT_V1.version } }, { ...data, improve_waldo: { ...data.improve_waldo, text: 'x' } }, { improve_waldo: data.improve_waldo }]) {
      expect(appControlProjectionV1Schema.safeParse(view(bad)).success).toBe(false);
    }
  });

  it('gives or withdraws Improve Waldo for everyone naming the version shown, from the agreements view alone', () => {
    expect(appControlActionV1Schema.safeParse(improve).success).toBe(true);
    expect(appControlActionV1Schema.safeParse({ ...improve, value: 'withdrawn' }).success).toBe(true);
    for (const bad of [{ ...improve, value: 'on' }, { ...improve, value: undefined }, { ...improve, notice: undefined }, { ...improve, view: 'account' }, { ...improve, id: 'improve_waldo' },
      { ...improve, confirmation: 'DELETE' }, { ...improve, account: 'signin' }, { view: 'agreements', action: 'proactive_surface.set', value: 'app', revision, request_id: 'agree-0002' }]) {
      expect(appControlActionV1Schema.safeParse(bad).success).toBe(false);
    }
  });

  it('has a fixed receipt per outcome, each a valid receipt', () => {
    for (const shown of Object.values(APP_IMPROVE_WALDO_RECEIPTS_V1)) expect(appControlReceiptV1Schema.safeParse(shown).success).toBe(true);
    expect(APP_IMPROVE_WALDO_RECEIPTS_V1.withdrawn.message).toContain(APP_IMPROVE_WALDO_AGREEMENT_V1.off.replace(/\.$/, ''));
  });
});
