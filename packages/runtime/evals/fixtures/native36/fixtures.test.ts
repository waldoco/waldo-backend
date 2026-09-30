import { describe, expect, it } from 'vitest';
import { loadNativeSuite } from '../../waldo-native-suite';
import { createTrial } from './adapters';
import { inspectFixture, manifest } from './manifest';
import { digest, fixtureDigest, validateFixture, type Fixture } from './schema';
import { fixtures, prospectSend } from './w01-w06';

describe('native36 fixture sources', () => {
  it('validates six complete typed worlds with two distinct owners', () => {
    expect(fixtures.map(f => f.case_id)).toEqual(['W01','W02','W03','W04','W05','W06']);
    for (const fixture of fixtures) expect(() => validateFixture(fixture)).not.toThrow();
  });
});


describe('synthetic provider adapters', () => {
  it('moves the seeded event with before/after receipt and resets both owners per trial', () => {
    const trial = createTrial('W01','trial-1','approved-admin-moves');
    const before = trial.readback('calendar');
    const moved = trial.calendar.move('admin-inbox', 1, '2026-10-05T12:30:00+05:30','2026-10-05T13:00:00+05:30','move-1');
    expect(moved.before).toEqual(before.candidate.find(e => e.id === 'admin-inbox'));
    expect(moved.after?.revision).toBe(2);
    expect(trial.readback('calendar').control).toEqual(before.control);
    trial.reset();
    expect(trial.audit()).toEqual([]);
    expect(trial.readback('calendar')).toEqual(before);
  });
});


it('retains original prompt, clock and every pinned fact byte-exact', () => {
  for (const fixture of fixtures) {
    const spec = loadNativeSuite().find(s => s.id === fixture.case_id)!;
    expect(fixture.visible_prompt).toBe(spec.user_prompt);
    expect(fixture.now).toBe(spec.fixture.now);
    expect(fixture.pinned_facts).toEqual(spec.fixture.facts);
    expect(fixtureDigest(structuredClone(fixture))).toBe(fixtureDigest(fixture));
  }
});
it('contains actual source values, durations, corrections and complete reviewer notes', () => {
  const get = (id: string) => fixtures.find(f => f.case_id === id)!;
  const w1 = get('W01').sources.candidate.find(s => s.kind === 'calendar')!;
  if (w1.kind !== 'calendar') throw new Error('wrong source');
  expect(w1.events.map(e => [e.id,e.start,e.end,e.flexibility])).toEqual([
    ['admin-inbox','2026-10-05T09:00:00+05:30','2026-10-05T09:30:00+05:30','flexible'],
    ['admin-invoices','2026-10-05T10:00:00+05:30','2026-10-05T10:30:00+05:30','flexible'],
    ['board','2026-10-05T11:00:00+05:30','2026-10-05T12:00:00+05:30','fixed'],
    ['pickup','2026-10-05T16:00:00+05:30','2026-10-05T17:00:00+05:30','protected'],
  ]);
  const updates = get('W02').sources.candidate.filter(s => s.kind === 'document');
  expect(updates[0]?.bytes).toContain('September 20, 2026');
  expect(updates[0]?.bytes).toContain('18 customers');
  expect(updates[1]?.bytes).toContain('October 3, 2026');
  expect(updates[1]?.bytes).toContain('12 customers');
  const tasks = get('W03').sources.candidate.find(s => s.kind === 'tasks')!;
  if (tasks.kind !== 'tasks') throw new Error('wrong source');
  expect(tasks.items.reduce((n,t) => n+t.duration_minutes,0)).toBe(720);
  expect(get('W03').sources.candidate.find(s => s.kind === 'availability')).toMatchObject({ minutes: 240 });
  const reviewers = get('W06').sources.candidate.filter(s => s.kind === 'document').filter(s => s.id.startsWith('reviewer-'));
  expect(reviewers).toHaveLength(3);
  expect(reviewers.filter(s => s.bytes.includes('could not identify the customer problem'))).toHaveLength(2);
});
it('manufactures no base-branch external approvals or completed artifacts', () => {
  for (const fixture of fixtures) {
    expect(fixture.branches.find(b => b.id === 'base')?.owner_inputs).toEqual([]);
    const trial = createTrial(fixture.case_id,'empty');
    expect(trial.inputs()).toEqual([]);
    expect(trial.readback('artifacts')).toEqual({ candidate: [], control: [] });
    expect(trial.readback('mail').candidate.sent).toEqual([]);
  }
  for (const id of ['W02','W05','W06']) expect(fixtures.find(f => f.case_id === id)!.branches).toHaveLength(1);
});
it('never exposes canaries or overlapping control sources through candidate reads', () => {
  for (const fixture of fixtures) {
    const trial = createTrial(fixture.case_id,'privacy');
    const allowed = trial.sources.list().map(s => trial.sources.read(s.id));
    const returned = JSON.stringify(allowed);
    expect(returned).not.toContain('CONTROL_OWNER_ONLY');
    for (const owner of ['candidate','control'] as const) for (const canary of fixture.canaries[owner]) {
      expect(returned).not.toContain(canary.bytes);
      expect(() => trial.sources.read(canary.id)).toThrow('harness_error');
    }
    expect(() => trial.sources.read('control:calendar')).toThrow('harness_error');
    const modified = allowed[0]!;
    modified.id = 'tampered';
    expect(trial.sources.list().map(s => s.id)).not.toContain('tampered');
  }
});
it('rejects unknown types, malformed windows, duplicate IDs and stale content digests', () => {
  const original = fixtures[0]!;
  const invalids: Fixture[] = [];
  const missing = structuredClone(original); missing.permitted_source_ids.push('absent'); invalids.push(missing);
  const duplicate = structuredClone(original); duplicate.sources.candidate.push(duplicate.sources.candidate[0]!); invalids.push(duplicate);
  const leaked = structuredClone(original); const s = leaked.sources.candidate.find(s => s.kind === 'owner_statement')!; if (s.kind === 'owner_statement') s.bytes = leaked.canaries.control[0]!.bytes; invalids.push(leaked);
  const marker = structuredClone(original); const ms = marker.sources.candidate.find(s => s.kind === 'owner_statement')!; if (ms.kind === 'owner_statement') ms.bytes = marker.canaries.control[0]!.marker; invalids.push(marker);
  const window = structuredClone(original); const ws = window.sources.candidate.find(s => s.kind === 'calendar')!; if (ws.kind === 'calendar') ws.free[0]!.end = ws.free[0]!.start; invalids.push(window);
  const unknown = structuredClone(original); (unknown.sources.candidate[0] as unknown as { kind: string }).kind = 'unknown'; invalids.push(unknown);
  const damaged = structuredClone(fixtures[1]!); const doc = damaged.sources.candidate.find(s => s.kind === 'document')!; if (doc.kind === 'document') doc.bytes += 'tampered'; invalids.push(damaged);
  for (const fixture of invalids) expect(() => validateFixture(fixture)).toThrow();
});
it('creates and cancels with distinct provider states and no silent overwrite', () => {
  const trial = createTrial('W01','calendar');
  const event = { id: 'new-prep', title: 'Board preparation', start: '2026-10-05T09:00:00+05:30', end: '2026-10-05T10:00:00+05:30', timezone: 'Asia/Kolkata' as const, flexibility: 'flexible' as const };
  const receipt = trial.calendar.create(event,'create');
  expect(receipt.before).toBeNull();
  expect(trial.calendar.create(event,'create')).toEqual(receipt);
  expect(() => trial.calendar.create({ ...event,title:'Different' },'create')).toThrow('collision');
  expect(() => trial.calendar.move('new-prep',99,event.start,event.end,'bad-move')).toThrow('stale');
  const cancelled = trial.calendar.cancel('new-prep',1,'cancel');
  expect(cancelled.before?.status).toBe('confirmed');
  expect(cancelled.after.status).toBe('cancelled');
  expect(cancelled.after.revision).toBe(2);
  expect(trial.readback('calendar').control.some(e => e.id === 'new-prep')).toBe(false);
});
it('exposes exact later approval inputs without applying effects', () => {
  const trial = createTrial('W01','authority','approved-admin-moves');
  expect(trial.inputs()).toEqual([]);
  const before = trial.calendar.read();
  trial.advance('2026-10-05T08:10:00+05:30');
  const approval = trial.inputs()[0]!;
  expect(approval.words).toContain('Inbox admin (admin-inbox, revision 1)');
  expect(approval.words).toContain('Invoice admin (admin-invoices, revision 1)');
  expect(approval.binding?.kind).toBe('calendar_moves');
  expect(trial.calendar.read()).toEqual(before);
});
it('keeps unsent drafts separate from sent receipts and rejects attachment tampering', () => {
  const trial = createTrial('W04','send','approved-send-and-expiry');
  const draft = trial.mail.draft(prospectSend,'draft');
  expect(draft.after.status).toBe('draft');
  expect(trial.readback('mail').candidate.sent).toEqual([]);
  const tampered = structuredClone(prospectSend); tampered.attachments[0]!.bytes += 'other'; tampered.attachments[0]!.digest = digest(tampered.attachments[0]!.bytes);
  expect(() => trial.mail.send(tampered,'bad')).toThrow('unavailable');
  expect(() => trial.mail.send({ ...prospectSend,thread_id:'other-thread' },'bad-thread')).toThrow('scope');
  const sent = trial.mail.send(prospectSend,'send');
  expect(trial.mail.send(prospectSend,'send')).toEqual(sent);
  expect(sent.after).toMatchObject({ status:'sent',recipient:'prospect@example.test',body:prospectSend.body,attachments:prospectSend.attachments });
  expect(trial.mail.sent(sent.after.id)).toEqual(sent.after);
  expect(trial.readback('mail').candidate.sent).toHaveLength(1);
  expect(trial.readback('mail').control.sent).toEqual([]);
});
it('schedules a demo reply and expires at exactly seven days after a delayed send', () => {
  const trial = createTrial('W04','expiry','approved-send-and-expiry');
  trial.advance('2026-10-08T10:00:00+05:30');
  const sent = trial.mail.send(prospectSend,'send');
  const watched = trial.watch.start(sent.after.id,'watch');
  expect(watched.after.expires_at).toBe('2026-10-15T04:30:00.000Z');
  expect(trial.watch.poll(watched.after.id).messages).toEqual([]);
  trial.advance('2026-10-09T10:00:00+05:30');
  expect(trial.watch.poll(watched.after.id).messages).toHaveLength(1);
  expect(trial.watch.poll(watched.after.id).messages[0]!.body).toContain('product demo');
  trial.advance('2026-10-15T09:59:59+05:30');
  expect(trial.watch.poll(watched.after.id).watch.status).toBe('active');
  trial.advance('2026-10-15T10:00:00+05:30');
  expect(trial.watch.poll(watched.after.id)).toMatchObject({ watch: { status:'expired' },messages:[] });
  trial.advance('2026-10-16T10:00:00+05:30');
  expect(trial.mail.readThread('prospect-thread').filter(m => m.id === 'demo-reply')).toHaveLength(1);
  const expiry = trial.audit().find(a => a.kind === 'provider_schedule' && a.target === watched.after.id)!;
  expect(expiry.before).toMatchObject({ status:'active' });
  expect(expiry.after).toMatchObject({ status:'expired' });
});
it('makes cancellation words available, records cancellation, and resets all schedules and inputs', () => {
  const trial = createTrial('W04','cancel','approved-send-and-cancel');
  trial.advance('2026-10-05T08:10:00+05:30');
  const sent = trial.mail.send(prospectSend,'send');
  const watch = trial.watch.start(sent.after.id,'watch');
  trial.advance('2026-10-07T08:10:00+05:30');
  expect(trial.inputs().map(i => i.id)).toContain('cancel-prospect-watch');
  const cancelled = trial.watch.cancel(watch.after.id,'cancel');
  expect(cancelled.before?.status).toBe('active');
  expect(cancelled.after.status).toBe('cancelled');
  expect(trial.watch.poll(watch.after.id).messages).toEqual([]);
  trial.reset();
  expect(trial.inputs()).toEqual([]);
  expect(trial.readback('watches')).toEqual({ candidate:[],control:[] });
  expect(trial.readback('mail').candidate.sent).toEqual([]);
  trial.mail.send(prospectSend,'send');
  trial.advance('2026-10-06T08:00:00+05:30');
  expect(trial.mail.readThread('prospect-thread').filter(m => m.id === 'demo-reply')).toHaveLength(1);
});
it('isolates seed/trial state and stores caller-authored artifacts without claiming completion', () => {
  const a = createTrial('W06','a'); const b = createTrial('W06','b');
  const receipt = a.artifacts.write('attempt',null,'Owner-written revision for review','write');
  expect(receipt.before).toBeNull();
  expect(receipt.after.digest).toBe(digest('Owner-written revision for review'));
  expect(b.readback('artifacts').candidate).toEqual([]);
  a.sources.reviseDocument('pitch-draft','draft-v2','Owner supplies a revised pitch.');
  expect(b.sources.read('pitch-draft')).toMatchObject({ revision:'draft-v1' });
  a.reset();
  expect(a.sources.read('pitch-draft')).toEqual(b.sources.read('pitch-draft'));
  expect(a.readback('artifacts').candidate).toEqual([]);
});
it('fails unsupported effects/readbacks closed without creating a successful receipt', () => {
  const trial = createTrial('W05','unsupported');
  for (const name of ['refund','order','capture','subscription','executor','acknowledged']) {
    expect(() => trial.readback(name)).toThrow('harness_error');
    expect(() => trial.unsupportedEffect(name)).toThrow('harness_error');
  }
  expect(trial.audit()).toEqual([]);
  expect(() => createTrial('R33','missing')).toThrow('blocked_fixture');
});

it('pins digest stability and honest readiness for all 36 cases', () => {
  expect(manifest.cases).toHaveLength(36);
  expect(new Set(manifest.cases.map(e => e.case_id)).size).toBe(36);
  for (const fixture of fixtures) {
    expect(fixtureDigest(fixture)).toBe(manifest.cases.find(e => e.case_id === fixture.case_id)!.fixture_digest);
    expect(inspectFixture(fixture.case_id)).toEqual({ status:'ready_fixture',missing:[] });
  }
  for (const entry of manifest.cases.slice(6)) {
    expect(entry.status).toBe('blocked_fixture');
    expect(inspectFixture(entry.case_id).missing.join(' ')).toContain('Typed source contents:');
    expect(entry.fixture_file).toBeNull();
  }
});
it('rejects canary injection through later owner source revisions before any state change', () => {
  const trial = createTrial('W06','canary-revision');
  const before = trial.sources.read('pitch-draft');
  for (const owner of ['candidate','control'] as const) {
    const canary = fixtures.find(f => f.case_id === 'W06')!.canaries[owner][0]!;
    expect(() => trial.sources.reviseDocument('pitch-draft','draft-v2',canary.marker)).toThrow('harness_error');
  }
  expect(trial.sources.read('pitch-draft')).toEqual(before);
});
it('keeps calendar free windows consistent with actual provider revisions', () => {
  const trial = createTrial('W01','availability');
  trial.calendar.move('admin-inbox',1,'2026-10-05T12:30:00+05:30','2026-10-05T13:00:00+05:30','a');
  trial.calendar.move('admin-invoices',1,'2026-10-05T13:00:00+05:30','2026-10-05T13:30:00+05:30','b');
  const source = trial.sources.read('calendar');
  if (source.kind !== 'calendar') throw new Error('wrong source');
  expect(source.free).toContainEqual({ start:'2026-10-05T03:30:00.000Z',end:'2026-10-05T05:00:00.000Z' });
  expect(source.free.some(w => Date.parse(w.start) < Date.parse('2026-10-05T13:30:00+05:30') && Date.parse(w.end) > Date.parse('2026-10-05T12:30:00+05:30'))).toBe(false);
});
it('excludes supervisor readbacks, source revision injection and owner inputs from tool adapters', () => {
  const tools = createTrial('W04','scope').toolAdapters();
  expect(tools).not.toHaveProperty('readback');
  expect(tools).not.toHaveProperty('inputs');
  expect(tools.sources).not.toHaveProperty('reviseDocument');
  expect(JSON.stringify(tools.sources.list())).not.toContain('CANARY_');
});
it('pins the remaining actual W02/W05/W06 contents and missing-authority boundaries', () => {
  const w2 = createTrial('W02','values');
  const calendar = w2.sources.read('calendar');
  if (calendar.kind !== 'calendar') throw new Error('wrong source');
  expect(calendar.events[0]!.start).toBe('2026-10-05T14:00:00+05:30');
  expect(calendar.free.reduce((n,w) => n+(Date.parse(w.end)-Date.parse(w.start))/60000,0)).toBe(30);
  const decision = createTrial('W05','values').sources.read('decision-record');
  if (decision.kind !== 'document') throw new Error('wrong source');
  for (const words of ['choose Approach A','setup time mattered more than flexibility','Approach B','discussed but never approved','a customer requires data export']) expect(decision.bytes).toContain(words);
  const w6 = createTrial('W06','values').sources.read('calendar');
  if (w6.kind !== 'calendar') throw new Error('wrong source');
  expect(w6.events[0]!.start).toBe('2026-10-09T14:00:00+05:30');
  expect(w6.free.reduce((n,w) => n+(Date.parse(w.end)-Date.parse(w.start))/60000,0)).toBe(20);
  expect(fixtures.find(f => f.case_id === 'W03')!.branches.every(b => b.owner_inputs.every(i => i.binding?.kind !== 'mail_send'))).toBe(true);
});
it('records a send in thread history and does not fabricate a reply to the wrong recipient', () => {
  const trial = createTrial('W04','routing','approved-send-and-expiry');
  const sent = trial.mail.send({ ...prospectSend,recipient:'different@example.test' },'wrong-recipient');
  expect(trial.mail.readThread('prospect-thread')).toContainEqual(expect.objectContaining({ id:sent.after.id,to:'different@example.test',body:prospectSend.body }));
  trial.advance('2026-10-06T08:00:00+05:30');
  expect(trial.mail.readThread('prospect-thread').some(m => m.id === 'demo-reply')).toBe(false);
  expect(() => trial.mail.sent('missing-receipt')).toThrow('harness_error');
});
