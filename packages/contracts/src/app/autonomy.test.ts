import { describe, expect, it } from 'vitest';
import {
  appAutonomyChangeResultV1Schema, appAutonomyChangeV1Schema, appAutonomyGrantTermsV1Schema, appAutonomyReceiptsQueryV1Schema,
  appAutonomyReceiptsV1Schema, appAutonomyReceiptV1Schema, appAutonomyRoutesV1, appAutonomyUndoResultV1Schema, appAutonomyUndoV1Schema,
  appAutonomyV1Schema, autonomyClassV1Schema,
} from './autonomy';
import fixture from './fixtures/autonomy.v1.json';

const [onBlocks, onSends, onErrands] = fixture.settings_on.classes;
const blockTerms = onBlocks!.grants[0]!.terms;
const sendTerms = onSends!.grants[0]!.terms;
const errandTerms = onErrands!.grants[0]!.terms;
const [held, moved, unknown] = fixture.receipts_page.receipts;
const DAY = 86_400_000;

describe('autonomy settings', () => {
  it('parses every example the app builds against', () => {
    for (const settings of [fixture.settings_off, fixture.settings_on, fixture.settings_paused]) expect(appAutonomyV1Schema.safeParse(settings).success).toBe(true);
    for (const change of fixture.changes) expect(appAutonomyChangeV1Schema.safeParse(change).success).toBe(true);
    expect(appAutonomyChangeResultV1Schema.safeParse(fixture.change_result).success).toBe(true);
    expect(appAutonomyReceiptsV1Schema.safeParse(fixture.receipts_page).success).toBe(true);
    expect(appAutonomyUndoV1Schema.safeParse(fixture.undo).success).toBe(true);
    expect(appAutonomyUndoResultV1Schema.safeParse(fixture.undo_result).success).toBe(true);
  });

  it('names every class once, so a class turned on later is never a new enum value', () => {
    expect(autonomyClassV1Schema.options).toEqual(['calendar.move_own_block', 'followup.close_on_reply', 'backlog.add_inferred', 'message.send_to_named', 'errand.run_on_site']);
    expect(fixture.settings_off.classes.map(entry => entry.class)).toEqual(autonomyClassV1Schema.options);
  });

  it('refuses a class twice, a grant under another class and a grant in a class not yet available', () => {
    const off = fixture.settings_off;
    expect(appAutonomyV1Schema.safeParse({ ...off, classes: [off.classes[0], off.classes[0]] }).success).toBe(false);
    expect(appAutonomyV1Schema.safeParse({ ...off, classes: [{ ...onBlocks, grants: onSends!.grants }] }).success).toBe(false);
    expect(appAutonomyV1Schema.safeParse({ ...off, classes: [{ ...onBlocks, availability: 'not_yet' }] }).success).toBe(false);
    expect(appAutonomyV1Schema.safeParse({ ...off, mode: 'auto' }).success).toBe(false);
  });
});

describe('grant terms', () => {
  it('bounds a grant to at most 90 days, ending after it starts', () => {
    expect(appAutonomyGrantTermsV1Schema.safeParse({ ...blockTerms, expires_at: blockTerms.valid_from + 90 * DAY }).success).toBe(true);
    expect(appAutonomyGrantTermsV1Schema.safeParse({ ...blockTerms, expires_at: blockTerms.valid_from + 90 * DAY + 1 }).success).toBe(false);
    expect(appAutonomyGrantTermsV1Schema.safeParse({ ...blockTerms, expires_at: blockTerms.valid_from }).success).toBe(false);
    expect(appAutonomyGrantTermsV1Schema.safeParse({ ...blockTerms, expires_at: 1_795_683_600 }).success).toBe(false);
  });

  it('caps uses per day between 1 and 20', () => {
    for (const max_per_day of [0, 21, 1.5]) expect(appAutonomyGrantTermsV1Schema.safeParse({ ...blockTerms, limits: { ...blockTerms.limits, max_per_day } }).success).toBe(false);
  });

  it('keeps a focus-block grant to a real window on named weekdays with a bounded lead', () => {
    const scope = blockTerms.scope;
    for (const bad of [
      { window: { from: '19:00', to: '08:00' } }, { window: { from: '8:00', to: '19:00' } }, { weekdays: [] }, { weekdays: [1, 1] },
      { weekdays: [7] }, { min_lead_minutes: 4 }, { min_lead_minutes: 241 }, { account: 'not an address' }, { calendar: 'team@example.com' },
    ]) expect(appAutonomyGrantTermsV1Schema.safeParse({ ...blockTerms, scope: { ...scope, ...bad } }).success).toBe(false);
  });

  it('names who a send reaches, on email or Slack only', () => {
    const scope = sendTerms.scope;
    for (const bad of [
      { recipients: [] }, { recipients: ['#a', '#a'] }, { recipients: Array.from({ length: 21 }, (_, i) => `#c${i}`) }, { channel: 'whatsapp' },
      { purpose: ' ' }, { purpose: 'line one\nline two' },
    ]) expect(appAutonomyGrantTermsV1Schema.safeParse({ ...sendTerms, scope: { ...scope, ...bad } }).success).toBe(false);
  });

  it('names https origins for an errand and a budget no single action exceeds', () => {
    const scope = errandTerms.scope;
    const budget = { currency: 'INR', per_action_minor: 200_000, per_30_days_minor: 800_000 };
    expect(appAutonomyGrantTermsV1Schema.safeParse({ ...errandTerms, scope: { ...scope, spend: budget } }).success).toBe(true);
    for (const bad of [
      { sites: ['http://www.goindigo.in'] }, { sites: ['https://www.goindigo.in/web-check-in'] }, { sites: ['https://localhost'] }, { sites: [] },
      { spend: { ...budget, per_action_minor: 900_000 } }, { spend: { ...budget, currency: 'inr' } }, { spend: { ...budget, per_action_minor: 0 } },
      { spend: undefined },
    ]) expect(appAutonomyGrantTermsV1Schema.safeParse({ ...errandTerms, scope: { ...scope, ...bad } }).success).toBe(false);
  });
});

describe('autonomy changes', () => {
  it('widens authority only against the revision the owner reviewed, and narrows it without one', () => {
    const [pause, revoke, resume, grant] = fixture.changes;
    expect(appAutonomyChangeV1Schema.safeParse({ ...pause, expected_revision: fixture.settings_on.revision }).success).toBe(false);
    expect(appAutonomyChangeV1Schema.safeParse({ ...revoke, expected_revision: fixture.settings_on.revision }).success).toBe(false);
    const { expected_revision: _resumed, ...resumeBlind } = resume!;
    const { expected_revision: _granted, ...grantBlind } = grant!;
    expect(appAutonomyChangeV1Schema.safeParse(resumeBlind).success).toBe(false);
    expect(appAutonomyChangeV1Schema.safeParse(grantBlind).success).toBe(false);
  });

  it('refuses an unknown operation, a level and a short request id', () => {
    expect(appAutonomyChangeV1Schema.safeParse({ request_id: 'autonomy-0009', change: { op: 'level', level: 'act_for_me' } }).success).toBe(false);
    expect(appAutonomyChangeV1Schema.safeParse({ request_id: 'short', change: { op: 'pause' } }).success).toBe(false);
    expect(appAutonomyChangeV1Schema.safeParse({ request_id: 'autonomy-0010', change: { op: 'pause', all: true } }).success).toBe(false);
  });
});

describe('what Waldo did for you', () => {
  it('claims done only with evidence, and never claims evidence for anything not done', () => {
    expect(appAutonomyReceiptV1Schema.safeParse({ ...moved, evidence: 'none' }).success).toBe(false);
    expect(appAutonomyReceiptV1Schema.safeParse({ ...unknown, evidence: 'readback' }).success).toBe(false);
    expect(appAutonomyReceiptV1Schema.safeParse({ ...held, evidence: 'provider_receipt' }).success).toBe(false);
    expect(appAutonomyReceiptV1Schema.safeParse({ ...unknown, state: 'not_done' }).success).toBe(true);
  });

  it('offers undo only on a done or held effect, and always on a held send', () => {
    expect(appAutonomyReceiptV1Schema.safeParse({ ...unknown, undo_until: 1_793_257_200_000 }).success).toBe(false);
    expect(appAutonomyReceiptV1Schema.safeParse({ ...held, undo_until: null }).success).toBe(false);
  });

  it('says whose authority ran it: a standing grant by class and revision, or the owner\'s yes on an approval', () => {
    expect(appAutonomyReceiptV1Schema.safeParse({ ...moved, authority: { kind: 'standing_grant', grant_id: 'g_focus_01', grant_revision: 1 } }).success).toBe(false);
    expect(appAutonomyReceiptV1Schema.safeParse({ ...moved, authority: { kind: 'standing_grant', class: 'calendar.delete', grant_id: 'g_focus_01', grant_revision: 1 } }).success).toBe(false);
    expect(appAutonomyReceiptV1Schema.safeParse({ ...moved, authority: { kind: 'model', reason: 'it seemed right' } }).success).toBe(false);
    expect(appAutonomyReceiptV1Schema.safeParse({ ...moved, reason: 'You looked tired.' }).success).toBe(false);
  });

  it('pages newest first with a bounded first page', () => {
    expect(appAutonomyReceiptsQueryV1Schema.safeParse({}).success).toBe(true);
    expect(appAutonomyReceiptsQueryV1Schema.safeParse({ before: fixture.receipts_page.next_cursor, limit: '50' }).success).toBe(true);
    for (const limit of ['0', '51', 'ten']) expect(appAutonomyReceiptsQueryV1Schema.safeParse({ limit }).success).toBe(false);
    expect(appAutonomyReceiptsV1Schema.safeParse({ receipts: Array.from({ length: 51 }, () => moved), next_cursor: null }).success).toBe(false);
  });
});

it('declares four authenticated routes under /app/v1/autonomy', () => {
  expect(appAutonomyRoutesV1.map(route => `${route.method} ${route.path}`)).toEqual([
    'GET /app/v1/autonomy', 'POST /app/v1/autonomy/changes', 'GET /app/v1/autonomy/receipts', 'POST /app/v1/autonomy/undo',
  ]);
  expect(appAutonomyRoutesV1.every(route => route.authenticated)).toBe(true);
});
