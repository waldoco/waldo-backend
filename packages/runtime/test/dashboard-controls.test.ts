import { describe, expect, it } from 'vitest';
import { CONTROLS_PATH, projectControls, readControlsQuery } from '../src/channels/dashboard-controls';
import type { ApprovalItem } from '../src/channels/approvals';
import { SAMPLE_CONSOLE_VIEW } from './fixtures/console-sample';

describe('narrow controls read projection', () => {
  it('accepts only explicit views and activity cursors, never identity selectors', () => {
    expect(CONTROLS_PATH).toBe('/console/dashboard/api/v1/controls');
    expect(readControlsQuery(new URLSearchParams('view=day'))).toEqual({ view: 'day', page: {} });
    expect(readControlsQuery(new URLSearchParams('view=activity&trace_before=23&runs_before=4'))).toEqual({ view: 'activity', page: { traceBefore: 23, runsBefore: 4 } });
    for (const query of ['', 'view=memory', 'view=day&owner=other', 'view=day&view=connections', 'view=day&trace_before=2', 'view=activity&trace_before=-1', 'view=activity&trace_before=1.5', 'view=activity&trace_before=Infinity', 'view=activity&trace_before=9007199254740992', 'view=activity&trace_before=', 'view=activity&trace_before=0', 'view=activity&trace_before=1&trace_before=2']) {
      expect(readControlsQuery(new URLSearchParams(query)), query).toBeNull();
    }
  });

  it('copies day fields only and preserves skipped cards, recorded sends and pins', () => {
    const source = { ...SAMPLE_CONSOLE_VIEW, cards: SAMPLE_CONSOLE_VIEW.cards.map((card) => ({ ...card, time: null, hidden: 'private-extension' })) };
    const result = projectControls(source, 'day');
    expect(result).toMatchObject({ version: 1, view: 'day', state: 'available', csrf: SAMPLE_CONSOLE_VIEW.csrf, data: { timezone: 'Asia/Kolkata' } });
    expect(result.data.cards).toHaveLength(3);
    expect(result.data.cards[0]).toMatchObject({ time: null, sent: true, pin: null });
    expect(result.data.cards[2]).toMatchObject({ time: null, sent: false, pin: '22:15' });
    expect(JSON.stringify(result)).not.toContain('private-extension');
    expect(JSON.stringify(result)).not.toContain('blood-panel');
    expect(result.data.proactivity).toEqual({ quiet_start: '23:00', quiet_end: '07:30', volume: 'normal', source_proactivity: false });
  });

  it('keeps granted accounts distinct from reconnect state without refresh errors or secrets', () => {
    const source = { ...SAMPLE_CONSOLE_VIEW, google: { connectAvailable: false, accounts: [
      { id: 'g1', email: 'owner@test.invalid', error: null, calendar: true, mail: false, tasks: true, refresh_token: 'secret-token' },
      { id: 'g2', email: 'work@test.invalid', error: 'secret-provider-error', calendar: false, mail: true, tasks: false },
    ] } };
    const result = projectControls(source, 'connections');
    expect(result.data).toMatchObject({ google: { connectAvailable: false, accounts: [
      { id: 'g1', health: 'access_granted', calendar: true, mail: false, tasks: true },
      { id: 'g2', health: 'needs_reconnect', mail: true },
    ] }, telegram: { linked: true, unlinkAvailable: true }, sessions: { count: 1 } });
    expect(JSON.stringify(result)).not.toContain('secret-');
    expect(JSON.stringify(result)).not.toContain('verified');
  });

  it('preserves exact safe proposal reviews and existing action eligibility', () => {
    const calendar = SAMPLE_CONSOLE_VIEW.approvals[0]!;
    const email: ApprovalItem = { id: 'email', kind: 'email_send', summary: 'Send proposal', state: 'open', undoable: false, review: { kind: 'email_send', to: ['to@test.invalid'], cc: [], bcc: [], subject: '<script>hostile</script>', body: 'Exact reviewed words' } };
    const proposals: ApprovalItem[] = [calendar, email, { ...email, id: 'review-only', state: 'review_only' }, { ...email, id: 'unconfirmed', state: 'unconfirmed' }, { ...calendar, id: 'no-review', review: null }, { ...calendar, id: 'undo', state: 'done', undoable: true }, { ...calendar, id: 'mismatch', review: email.review }];
    const result = projectControls({ ...SAMPLE_CONSOLE_VIEW, approvals: proposals }, 'waiting');
    expect(result.data.proposals.map((p) => ({ id: p.id, actions: p.actions }))).toEqual([
      { id: calendar.id, actions: ['approval.approve', 'approval.skip'] },
      { id: 'email', actions: ['approval.skip'] }, { id: 'review-only', actions: ['approval.skip'] },
      { id: 'unconfirmed', actions: [] }, { id: 'no-review', actions: [] },
      { id: 'undo', actions: ['approval.undo'] }, { id: 'mismatch', actions: [] },
    ]);
    expect(result.data.proposals[1]?.review).toEqual(email.review);
    expect(result.data.proposals[6]?.review).toBeNull();
  });

  it('whitelists review fields rather than copying stored payload or extensions', () => {
    const review = { ...SAMPLE_CONSOLE_VIEW.approvals[0]!.review!, raw: 'secret-mime', payload_json: 'secret-json' };
    const result = projectControls({ ...SAMPLE_CONSOLE_VIEW, approvals: [{ ...SAMPLE_CONSOLE_VIEW.approvals[0]!, review }] }, 'waiting');
    expect(JSON.stringify(result)).not.toContain('secret-');
    expect(result.data.proposals[0]?.review).toMatchObject({ kind: 'calendar_change', event_id: 'gym-1' });
  });

  it('projects recorded activity summaries and pagination without raw trace fields', () => {
    const source = { ...SAMPLE_CONSOLE_VIEW, trace: [{ time: '12:00', trace: 'private-source-id', hop: 'tool_attempt', ok: false, ms: 20, note: 'Recorded failure', detail: 'secret-detail', error: 'secret-error' }], page: { trace_before: 10, runs_before: 5, trace_applied: 20, runs_applied: null } };
    const result = projectControls(source, 'activity');
    expect(result.data.trace).toEqual([{ time: '12:00', hop: 'tool_attempt', ok: false, ms: 20, summary: 'Recorded failure' }]);
    expect(result.data.page).toEqual(source.page);
    expect(JSON.stringify(result)).not.toContain('secret-');
    expect(JSON.stringify(result)).not.toContain('private-source-id');
    expect(result.data.runs[3]).toMatchObject({ status: 'running', ended: null, summary: null });
  });

  it('suppresses profile while removal is incomplete without leaking purge text or ids', () => {
    const result = projectControls(SAMPLE_CONSOLE_VIEW, 'profile');
    expect(result.data).toEqual({ sections: [], barriers: 1, removal: { state: 'incomplete', pending_count: 1 }, holds: [{ kind: 'observation', reason: 'self-report', created_at: '2026-09-25T22:00:00.000Z' }] });
    expect(JSON.stringify(result)).not.toContain('4123');
    expect(JSON.stringify(result)).not.toContain('source_ref');
    const complete = projectControls({ ...SAMPLE_CONSOLE_VIEW, forgettingSpots: [] }, 'profile');
    expect(complete.data.sections).toEqual(SAMPLE_CONSOLE_VIEW.profile);
    expect(complete.data.removal).toEqual({ state: 'none_recorded', pending_count: 0 });
  });

  it('derives setup from actual prerequisites rather than harness step success', () => {
    const result = projectControls({ ...SAMPLE_CONSOLE_VIEW, telegram: { linked: false, unlinkAvailable: true }, proactivity: { quiet_start: null, quiet_end: null, volume: 'normal' } }, 'setup');
    expect(result.data).toEqual({ telegram_linked: false, google_access_granted: false, quiet_hours_set: false });
    expect(JSON.stringify(result)).not.toContain('Chat reply');
    const reconnect = projectControls({ ...SAMPLE_CONSOLE_VIEW, google: { connectAvailable: true, accounts: [{ id: 'g1', email: 'owner@test.invalid', error: 'refresh_failed', calendar: true, mail: true, tasks: false }] } }, 'setup');
    expect(reconnect.data).toEqual({ telegram_linked: true, google_access_granted: false, quiet_hours_set: true });
    const granted = projectControls({ ...SAMPLE_CONSOLE_VIEW, google: { connectAvailable: true, accounts: [{ id: 'g1', email: 'owner@test.invalid', error: null, calendar: true, mail: true, tasks: false }] } }, 'setup');
    expect(granted.data).toEqual({ telegram_linked: true, google_access_granted: true, quiet_hours_set: true });
  });

  it('keeps usage estimates and Telegram references scoped without provider file ids', () => {
    expect(projectControls(SAMPLE_CONSOLE_VIEW, 'usage').data.rows).toEqual(SAMPLE_CONSOLE_VIEW.usage);
    const files = projectControls(SAMPLE_CONSOLE_VIEW, 'files');
    expect(files.data.storage).toBe('telegram_reference');
    expect(files.data.items).toHaveLength(2);
    expect(files.data.items[0]).toMatchObject({ id: 2, name: 'blood-panel-sept.pdf', size: 482000 });
    expect(JSON.stringify(files)).not.toContain('file_id');
    expect(JSON.stringify(files)).not.toContain('refresh_token');
  });
});
