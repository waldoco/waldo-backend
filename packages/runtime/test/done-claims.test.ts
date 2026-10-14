import { describe, expect, it } from 'vitest';
import type { LoopEventLike } from '../src/hooks/claim-hook';
import { CLAIMABLE_EFFECTS, doneClaimDesk, NOTE_DONE_TOOL, noteDoneArgsSchema } from '../src/hooks/done-claims';

const sent = (seq: number, extra: Partial<LoopEventLike> = {}): LoopEventLike => ({ seq, call: { name: 'send_message', args: { text: 'x' } }, ok: true, ...extra });
const deskOver = (events: LoopEventLike[]) => doneClaimDesk(() => events);

describe('note_done schema', () => {
  it('accepts a known effect, with a ref', () => {
    expect(noteDoneArgsSchema.safeParse({ effect: 'reminder_set' }).success).toBe(true);
    expect(noteDoneArgsSchema.safeParse({ effect: 'workspace_file_written', ref: 'notes/plan.md' }).success).toBe(true);
  });
  it('rejects an unknown effect, a missing effect, an empty ref and extra keys', () => {
    expect(noteDoneArgsSchema.safeParse({ effect: 'email_sent' }).success).toBe(false);
    expect(noteDoneArgsSchema.safeParse({}).success).toBe(false);
    expect(noteDoneArgsSchema.safeParse({ effect: 'reminder_set', ref: '' }).success).toBe(false);
    expect(noteDoneArgsSchema.safeParse({ effect: 'reminder_set', text: 'sent!' }).success).toBe(false);
  });
  it('offers exactly the claimable effects to the model', () => {
    expect(CLAIMABLE_EFFECTS).toContain('message_send_proposed');
    expect(CLAIMABLE_EFFECTS).not.toContain(null);
    expect(JSON.stringify(NOTE_DONE_TOOL.parameters)).toContain('"reminder_set"');
  });
});

describe('doneClaimDesk', () => {
  it('a claim with no effect call is unbacked: the model hears it, revision has host facts, the notice names it', () => {
    const desk = deskOver([]);
    expect(JSON.parse(desk.note('{"effect":"message_send_proposed"}'))).toEqual({ ok: true, noted: true, backed: false, finding: 'no_matching_receipt' });
    expect(desk.revision()).toContain('message_send_proposed (no_matching_receipt)');
    expect(desk.revision()).toContain('Receipts this turn: none');
    expect(desk.notice()).toBe('Not confirmed: message send proposed (nothing ran)');
  });

  it('a claim backed by an earlier accepted receipt needs no revision and no notice', () => {
    const desk = deskOver([sent(1)]);
    expect(JSON.parse(desk.note('{"effect":"message_send_proposed"}'))).toEqual({ ok: true, noted: true, backed: true });
    expect(desk.revision()).toBeNull();
    expect(desk.notice()).toBeNull();
  });

  it('a receipt that lands after the claim does not back it', () => {
    const events: LoopEventLike[] = [];
    const desk = deskOver(events);
    desk.note('{"effect":"message_send_proposed"}');
    events.push(sent(1));
    expect(desk.notice()).toBe('Not confirmed: message send proposed (nothing ran)');
  });

  it('failed and unresolved receipts are named as such', () => {
    const failed = deskOver([sent(1, { ok: false })]);
    failed.note('{"effect":"message_send_proposed"}');
    expect(failed.revision()).toContain('message_send_proposed (receipt_failed)');
    expect(failed.notice()).toBe('Not confirmed: message send proposed (it failed)');
    const unknown = deskOver([sent(1, { ok: false, receiptStatus: 'unavailable' })]);
    unknown.note('{"effect":"message_send_proposed"}');
    expect(unknown.revision()).toContain('(receipt_unresolved)');
    expect(unknown.notice()).toBe('Not confirmed: message send proposed (outcome unknown)');
  });

  it('a delegated child receipt backs the parent claim', () => {
    const desk = deskOver([sent(1, { delegated: true })]);
    desk.note('{"effect":"message_send_proposed"}');
    expect(desk.notice()).toBeNull();
  });

  it('a check that throws fails closed: every claim is not confirmed, and no revision is spent on it', () => {
    const desk = doneClaimDesk(() => [sent(1)], () => { throw new Error('boom'); });
    expect(JSON.parse(desk.note('{"effect":"message_send_proposed"}'))).toMatchObject({ backed: false, finding: 'check_unavailable' });
    expect(desk.revision()).toBeNull();
    expect(desk.notice()).toBe('Not confirmed: message send proposed (not checked)');
  });

  it('a malformed declaration is refused and records nothing', () => {
    const desk = deskOver([]);
    expect(JSON.parse(desk.note('{"effect":"sent"}'))).toMatchObject({ ok: false });
    expect(JSON.parse(desk.note('not json'))).toMatchObject({ ok: false });
    expect(desk.notice()).toBeNull();
  });

  it('a ref only narrows effects whose receipts carry one', () => {
    const file = (path: string): LoopEventLike => ({ seq: 1, call: { name: 'workspace_write', args: { path } }, ok: true });
    const wrongFile = deskOver([file('a.md')]);
    wrongFile.note('{"effect":"workspace_file_written","ref":"b.md"}');
    expect(wrongFile.notice()).toBe('Not confirmed: workspace file written (nothing ran)');
    const reminder = deskOver([{ seq: 1, call: { name: 'set_reminder', args: {} }, ok: true }]);
    reminder.note('{"effect":"reminder_set","ref":"call mom"}');
    expect(reminder.notice()).toBeNull();
  });

  it('superseding drops the earlier claims', () => {
    const desk = deskOver([]);
    desk.note('{"effect":"message_send_proposed"}');
    desk.supersede();
    expect(desk.notice()).toBeNull();
  });
});
