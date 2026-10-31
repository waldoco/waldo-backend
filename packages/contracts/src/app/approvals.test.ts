import { describe, expect, it } from 'vitest';
import {
  appApprovalDecisionResultV1Schema,
  appApprovalDecisionV1Schema,
  appApprovalListQueryV1Schema,
  appApprovalListV1Schema,
  appApprovalRoutesV1,
  appApprovalStateV1Schema,
  appApprovalAtRevision,
  appApprovalV1Schema,
  APP_APPROVALS_AGENT_MAIL_REVISION,
  APP_APPROVALS_CONTRACT_REVISION,
  type AppApprovalV1,
} from './approvals';
import { appControlReceiptV1Schema, appControlRequestIdV1Schema } from './controls';
import { payloadDigestV1Schema, replyApprovalPartV1Schema } from './parts';

const digest = `sha256:${'a'.repeat(64)}`;
const expiresAtMs = Date.UTC(2026, 9, 11, 4, 0, 0);
const email = {
  approval_id: 'p0001', kind: 'email_send', state: 'open',
  review: 'From: me@example.com\nTo: sam@example.com\nSubject: Friday\n\nSee you at 4.',
  exact: { recipients: { to: ['sam@example.com'], cc: [], bcc: [] }, scope: 'me@example.com' },
  payload_digest: digest, expires_at: expiresAtMs, actions: ['approve', 'edit', 'skip'], presented_surfaces: ['telegram', 'app'],
} as const;
const calendar = {
  ...email, approval_id: 'p0002', kind: 'calendar_change', review: 'Move "Design review" to Fri 16:00 to 17:00.',
  exact: { changes: { action: 'move', title: 'Design review', start: '2026-10-11T16:00:00+01:00', end: '2026-10-11T17:00:00+01:00' } },
} as const;
const message = { ...email, approval_id: 'p0003', kind: 'message_send', review: 'Send this on whatsapp: "Running late."', exact: { recipients: { to: ['whatsapp'], cc: [], bcc: [] } } } as const;
const browser = { ...email, approval_id: 'p0004', kind: 'browser_submit', review: 'Book the 18:30 table on the reservation page.', exact: { scope: 'https://reservations.example/book' }, actions: ['approve', 'skip'] } as const;
const mcp = { ...email, approval_id: 'p0005', kind: 'mcp_call', review: 'Run lookup on the crm server.', exact: { scope: 'lookup on the crm server' }, actions: ['approve', 'skip'] } as const;
const task = {
  ...email, approval_id: 'p0006', kind: 'google_task_change', review: 'Google task change to review\nAction: Edit',
  exact: { task: { action: 'update', account: 'me@example.com', list: 'Errands', task: 'Buy milk', changes: { title: { before: 'Buy milk', after: 'Buy oat milk' }, due_date: { before: null, after: '2026-10-12' } } } },
} as const;
const decision = { approval_id: 'p0001', action: 'approve', expected_digest: digest, request_id: 'decision-0001' } as const;
const result = { request_id: 'decision-0001', receipt: { state: 'rejected', message: 'That proposal changed. Review the new version.' }, duplicate: false, approval_state: 'superseded' } as const;

describe('appApprovalV1', () => {
  it('accepts one open approval of every kind with the exact block that kind needs', () => {
    for (const approval of [email, calendar, message, browser, mcp, task]) expect(appApprovalV1Schema.safeParse(approval).success).toBe(true);
  });

  it('requires recipients for sends, changes for calendar and scope for browser and MCP actions', () => {
    const recipients = { to: ['sam@example.com'], cc: [], bcc: [] };
    expect(appApprovalV1Schema.safeParse({ ...email, exact: { scope: 'me@example.com' } }).success).toBe(false);
    expect(appApprovalV1Schema.safeParse({ ...message, exact: { scope: 'whatsapp' } }).success).toBe(false);
    expect(appApprovalV1Schema.safeParse({ ...email, exact: { recipients: { to: [], cc: ['x@example.com'], bcc: [] } } }).success).toBe(false);
    expect(appApprovalV1Schema.safeParse({ ...calendar, exact: { scope: 'me@example.com' } }).success).toBe(false);
    expect(appApprovalV1Schema.safeParse({ ...browser, exact: { recipients } }).success).toBe(false);
    expect(appApprovalV1Schema.safeParse({ ...mcp, exact: { changes: calendar.exact.changes } }).success).toBe(false);
    expect(appApprovalV1Schema.safeParse({ ...mcp, exact: {} }).success).toBe(false);
  });

  it('maps every desk ledger status to one state, with no state implying an effect landed before it did', () => {
    expect(appApprovalStateV1Schema.options).toEqual([
      'unconfirmed', 'open', 'review_only', 'edit_requested', 'skipped', 'expired', 'superseded', 'done', 'not_done', 'outcome_unknown', 'undone',
    ]);
  });

  it('offers decisions only where the desk accepts them', () => {
    expect(appApprovalV1Schema.safeParse({ ...email, state: 'review_only', actions: ['skip'] }).success).toBe(true);
    expect(appApprovalV1Schema.safeParse({ ...calendar, state: 'done', actions: ['undo'] }).success).toBe(true);
    expect(appApprovalV1Schema.safeParse({ ...email, state: 'outcome_unknown', actions: [] }).success).toBe(true);
    expect(appApprovalV1Schema.safeParse({ ...email, state: 'review_only', actions: ['approve', 'skip'] }).success).toBe(false);
    expect(appApprovalV1Schema.safeParse({ ...email, state: 'superseded' }).success).toBe(false);
    expect(appApprovalV1Schema.safeParse({ ...email, state: 'outcome_unknown', actions: ['approve'] }).success).toBe(false);
    expect(appApprovalV1Schema.safeParse({ ...email, state: 'open', actions: ['undo'] }).success).toBe(false);
    expect(appApprovalV1Schema.safeParse({ ...email, actions: ['skip', 'skip'] }).success).toBe(false);
  });

  it('expires_at is epoch milliseconds: a seconds value or a fraction fails', () => {
    expect(appApprovalV1Schema.safeParse({ ...email, expires_at: Math.floor(expiresAtMs / 1000) }).success).toBe(false);
    expect(appApprovalV1Schema.safeParse({ ...email, expires_at: expiresAtMs + 0.5 }).success).toBe(false);
  });

  it('rejects merged recipients, raw arguments, free-text times and unknown keys', () => {
    expect(appApprovalV1Schema.safeParse({ ...email, exact: { recipients: ['sam@example.com'] } }).success).toBe(false);
    expect(appApprovalV1Schema.safeParse({ ...email, exact: { ...email.exact, args: { query: 'x' } } }).success).toBe(false);
    expect(appApprovalV1Schema.safeParse({ ...calendar, exact: { changes: { ...calendar.exact.changes, start: 'Friday 4pm' } } }).success).toBe(false);
    expect(appApprovalV1Schema.safeParse({ ...email, raw: 'MIME' }).success).toBe(false);
  });

  it('a Google task change shows the task block with only changed fields, and never provider ids', () => {
    expect(appApprovalV1Schema.safeParse(task).success).toBe(true);
    const created = { action: 'create', account: 'me@example.com', list: 'Errands', task: null, changes: { title: { before: null, after: 'Call Sam' }, notes: { before: null, after: 'About Friday' } } };
    expect(appApprovalV1Schema.safeParse({ ...task, exact: { task: created } }).success).toBe(true);
    expect(appApprovalV1Schema.safeParse({ ...task, exact: { task: { ...task.exact.task, changes: { status: { before: 'todo', after: 'done' } }, action: 'complete' } } }).success).toBe(true);
    expect(appApprovalV1Schema.safeParse({ ...task, exact: { scope: 'Errands' } }).success).toBe(false);
    for (const leak of [{ task_id: 't1' }, { etag: '"e1"' }, { connection_id: 'c1' }, { task_list_id: 'l1' }])
      expect(appApprovalV1Schema.safeParse({ ...task, exact: { task: { ...task.exact.task, ...leak } } }).success).toBe(false);
    expect(appApprovalV1Schema.safeParse({ ...task, exact: { task: { ...task.exact.task, changes: { title: { before: 'a', after: 'b', id: 't1' } } } } }).success).toBe(false);
    expect(appApprovalV1Schema.safeParse({ ...task, exact: { task: { ...task.exact.task, action: 'delete' } } }).success).toBe(false);
    expect(appApprovalV1Schema.safeParse({ ...task, exact: { task: { ...task.exact.task, account: 'not-an-address' } } }).success).toBe(false);
    expect(appApprovalV1Schema.safeParse({ ...task, exact: { task: { ...task.exact.task, changes: { due_date: { before: null, after: 'Friday' } } } } }).success).toBe(false);
    expect(appApprovalV1Schema.safeParse({ ...task, exact: { task: { ...task.exact.task, changes: { due_date: { before: '2026-10-12', after: null } } } } }).success).toBe(true);
    expect(appApprovalV1Schema.safeParse({ ...task, exact: { task: { ...task.exact.task, changes: { notes: { before: 'Oat, not dairy', after: null } } } } }).success).toBe(true);
    expect(appApprovalV1Schema.safeParse({ ...task, exact: { task: { ...task.exact.task, changes: { title: { before: 'Buy milk', after: null } } } } }).success).toBe(false);
    expect(appApprovalV1Schema.safeParse({ ...task, exact: { task: { ...task.exact.task, changes: { notes: { before: null, after: 'x'.repeat(8193) } } } } }).success).toBe(false);
    const { approval_id, kind, review, payload_digest, expires_at } = task;
    expect(replyApprovalPartV1Schema.safeParse({ type: 'approval', approval_id, kind, review, payload_digest, expires_at, actions: ['approve', 'edit', 'skip'], fallback_text: review }).success).toBe(true);
  });

  it('rejects unknown kinds and surfaces, bare digests and blank reviews', () => {
    expect(appApprovalV1Schema.safeParse({ ...email, kind: 'task_sources' }).success).toBe(false);
    expect(appApprovalV1Schema.safeParse({ ...email, presented_surfaces: ['sms'] }).success).toBe(false);
    expect(appApprovalV1Schema.safeParse({ ...email, presented_surfaces: ['app', 'app'] }).success).toBe(false);
    expect(appApprovalV1Schema.safeParse({ ...email, payload_digest: 'a'.repeat(64) }).success).toBe(false);
    expect(appApprovalV1Schema.safeParse({ ...email, review: ' ' }).success).toBe(false);
    const { presented_surfaces: _surfaces, ...unpresented } = email;
    expect(appApprovalV1Schema.safeParse(unpresented).success).toBe(true);
  });

  it('lists approvals in a bounded strict envelope, filterable by one state', () => {
    expect(appApprovalListV1Schema.safeParse({ approvals: [email, calendar] }).success).toBe(true);
    expect(appApprovalListV1Schema.safeParse({ approvals: [] }).success).toBe(true);
    expect(appApprovalListV1Schema.safeParse({ approvals: Array.from({ length: 101 }, () => email) }).success).toBe(false);
    expect(appApprovalListV1Schema.safeParse({ approvals: [], next_cursor: null }).success).toBe(false);
    expect(appApprovalListQueryV1Schema.safeParse({}).success).toBe(true);
    expect(appApprovalListQueryV1Schema.safeParse({ state: 'open' }).success).toBe(true);
    expect(appApprovalListQueryV1Schema.safeParse({ state: 'approved' }).success).toBe(false);
    expect(appApprovalListQueryV1Schema.safeParse({ state: 'open,done' }).success).toBe(false);
    expect(appApprovalListQueryV1Schema.safeParse({ state: 'open', limit: '5' }).success).toBe(false);
  });
});

describe('approval decisions', () => {
  it('decides against the exact digest with the /actions request id field', () => {
    expect(appApprovalDecisionV1Schema.shape.request_id).toBe(appControlRequestIdV1Schema);
    expect(appApprovalDecisionV1Schema.shape.expected_digest).toBe(payloadDigestV1Schema);
    for (const action of ['approve', 'skip', 'edit', 'undo']) expect(appApprovalDecisionV1Schema.safeParse({ ...decision, action }).success).toBe(true);
    expect(appApprovalDecisionV1Schema.safeParse({ ...decision, action: 'deny' }).success).toBe(false);
    expect(appApprovalDecisionV1Schema.safeParse({ ...decision, expected_digest: undefined }).success).toBe(false);
    expect(appApprovalDecisionV1Schema.safeParse({ ...decision, request_id: 'short' }).success).toBe(false);
    const { request_id, ...unnamed } = decision;
    expect(appApprovalDecisionV1Schema.safeParse({ ...unnamed, client_request_id: request_id }).success).toBe(false);
    expect(appApprovalDecisionV1Schema.safeParse({ ...decision, surface: 'app' }).success).toBe(false);
  });

  it('returns the /actions receipt unchanged and carries superseded in a new field', () => {
    expect(appApprovalDecisionResultV1Schema.shape.receipt).toBe(appControlReceiptV1Schema);
    expect(appApprovalDecisionResultV1Schema.safeParse(result).success).toBe(true);
    expect(appApprovalDecisionResultV1Schema.safeParse({ ...result, receipt: { state: 'recorded', message: 'Moved.' }, approval_state: 'done' }).success).toBe(true);
    expect(appApprovalDecisionResultV1Schema.safeParse({ ...result, receipt: { state: 'superseded', message: 'x' } }).success).toBe(false);
    const { approval_state: _state, ...bare } = result;
    expect(appApprovalDecisionResultV1Schema.safeParse(bare).success).toBe(false);
    expect(appApprovalDecisionResultV1Schema.safeParse({ ...result, effect_id: 'e1' }).success).toBe(false);
  });

  it('publishes the list route with its state query and the decision route', () => {
    expect(appApprovalRoutesV1.map(route => `${route.method} ${route.path}`)).toEqual(['GET /app/v1/approvals', 'POST /app/v1/approvals/decisions']);
    expect(appApprovalRoutesV1[0].query).toBe(appApprovalListQueryV1Schema);
  });
});

describe('not now', () => {
  const part = { type: 'approval', approval_id: 'p0001', kind: 'email_send', review: email.review, payload_digest: digest, expires_at: expiresAtMs, fallback_text: 'Open Waldo to review this email.' };
  it('defers an open or review-only approval, separately from skip', () => {
    expect(appApprovalDecisionV1Schema.safeParse({ ...decision, action: 'defer' }).success).toBe(true);
    expect(appApprovalV1Schema.safeParse({ ...email, actions: ['approve', 'edit', 'skip', 'defer'] }).success).toBe(true);
    expect(appApprovalV1Schema.safeParse({ ...email, state: 'review_only', actions: ['skip', 'defer'] }).success).toBe(true);
    expect(replyApprovalPartV1Schema.safeParse({ ...part, actions: ['approve', 'edit', 'skip', 'defer'] }).success).toBe(true);
  });
  it('refuses a defer where the desk cannot defer, and repeated or extra actions', () => {
    expect(appApprovalV1Schema.safeParse({ ...calendar, state: 'done', actions: ['undo', 'defer'] }).success).toBe(false);
    expect(appApprovalV1Schema.safeParse({ ...email, state: 'skipped', actions: ['defer'] }).success).toBe(false);
    expect(appApprovalV1Schema.safeParse({ ...email, actions: ['approve', 'edit', 'skip', 'defer', 'defer'] }).success).toBe(false);
    expect(appApprovalV1Schema.safeParse({ ...email, actions: ['defer', 'defer'] }).success).toBe(false);
    expect(replyApprovalPartV1Schema.safeParse({ ...part, actions: ['approve', 'edit', 'skip', 'defer', 'undo'] }).success).toBe(false);
    expect(replyApprovalPartV1Schema.safeParse({ ...part, actions: ['defer', 'defer'] }).success).toBe(false);
  });
});

describe('the wording a server may send with an approval', () => {
  const worded = { ...email, question: 'Send "Friday" to sam@example.com?', labels: { approve: 'Send email', skip: "Don't do this" } } as const;
  const card = (approval: Readonly<Record<string, unknown>>) => {
    const { approval_id, kind, review, payload_digest, expires_at, actions, question, labels } = approval;
    return { type: 'approval', approval_id, kind, review, payload_digest, expires_at, actions, fallback_text: review,
      ...(question === undefined ? {} : { question }), ...(labels === undefined ? {} : { labels }) };
  };
  const done = { ...calendar, state: 'done', actions: ['undo'], labels: { undo: 'Undo' }, undo_until: expiresAtMs } as const;

  it('accepts a one-line question and labels for offered actions, in the list and on the chat card; an action may go unlabelled', () => {
    expect(appApprovalV1Schema.safeParse(worded).success).toBe(true);
    expect(replyApprovalPartV1Schema.safeParse(card(worded)).success).toBe(true);
  });

  it('accepts when undo closes, while undo is offered', () => {
    expect(appApprovalV1Schema.safeParse(done).success).toBe(true);
  });

  it('is optional, so an approval without it parses as before', () => {
    expect(appApprovalV1Schema.safeParse(email).success).toBe(true);
    expect(replyApprovalPartV1Schema.safeParse(card(email)).success).toBe(true);
  });

  it.each([
    ['a question on two lines', { question: 'Send "Friday"\nto sam@example.com?' }],
    ['a blank question', { question: '   ' }],
    ['a question over 120 characters', { question: `Send "${'x'.repeat(120)}"?` }],
    ['a label over 40 characters', { labels: { approve: 'x'.repeat(41) } }],
    ['a blank label', { labels: { skip: ' ' } }],
    ['a label for an action not offered', { labels: { defer: 'Skip' } }],
    ['a label for an unknown action', { labels: { later: 'Later' } }],
  ])('rejects %s, in the list and on the chat card', (_shape, change) => {
    expect(appApprovalV1Schema.safeParse({ ...worded, ...change }).success).toBe(false);
    expect(replyApprovalPartV1Schema.safeParse(card({ ...worded, ...change })).success).toBe(false);
  });

  it('rejects when undo closes on an approval that offers no undo', () => {
    expect(appApprovalV1Schema.safeParse({ ...worded, undo_until: expiresAtMs }).success).toBe(false);
    expect(appApprovalV1Schema.safeParse({ ...done, actions: [], labels: undefined }).success).toBe(false);
  });
});

describe('calendar details, approvals revision 2', () => {
  const details = {
    guests: ['sam@example.com', 'pat@example.org'], emails_guests: true, location: 'Room 4', calendar: 'team@group.calendar.google.com', account: 'me@example.com',
    previous: { start: '2026-10-11T15:00:00+01:00', end: '2026-10-11T16:00:00+01:00' }, time_zone: 'Europe/London',
  } as const;
  const detailed = { ...calendar, exact: { changes: { ...calendar.exact.changes, ...details } } };
  const withChange = (key: string, value: unknown) => ({ ...calendar, exact: { changes: { ...calendar.exact.changes, [key]: value } } });

  it('accepts each detail alone and all together', () => {
    for (const [key, value] of Object.entries(details)) expect([key, appApprovalV1Schema.safeParse(withChange(key, value)).success]).toEqual([key, true]);
    expect(appApprovalV1Schema.safeParse(detailed).success).toBe(true);
  });

  it('rejects each detail in a wrong shape', () => {
    const invalid: readonly (readonly [string, unknown])[] = [
      ['guests', []], ['guests', ['not an address']], ['emails_guests', 'all'], ['location', ''], ['location', 'x'.repeat(301)],
      ['calendar', ''], ['account', 'me'], ['previous', { start: '2026-10-11T15:00:00+01:00' }], ['previous', { start: 'Fri 15:00', end: 'Fri 16:00' }],
      ['previous', { ...details.previous, event_id: 'e1' }], ['time_zone', ''], ['time_zone', 'x'.repeat(65)],
    ];
    for (const [key, value] of invalid) expect([key, value, appApprovalV1Schema.safeParse(withChange(key, value)).success]).toEqual([key, value, false]);
  });

  it('a build reading revision 1 gets exactly the shape before the details, and a later build gets them all', () => {
    const parsed = appApprovalV1Schema.parse(detailed) as AppApprovalV1;
    expect(JSON.stringify(appApprovalAtRevision(parsed, 1))).toBe(JSON.stringify(calendar));
    expect(appApprovalAtRevision(parsed, APP_APPROVALS_CONTRACT_REVISION)).toBe(parsed);
    const mail = appApprovalV1Schema.parse(email) as AppApprovalV1;
    expect(appApprovalAtRevision(mail, 1)).toBe(mail);
  });
});

describe('the exact draft of a send, approvals revision 3', () => {
  const mailDraft = { ...email, exact: { ...email.exact, message: { subject: 'Friday', body: 'See you at 4.' } } };
  const messageDraft = { ...message, exact: { ...message.exact, message: { subject: null, body: 'Running late.' } } };
  const withMessage = <T extends { exact: object }>(approval: T, draft: unknown) => ({ ...approval, exact: { ...approval.exact, message: draft } });

  it('accepts the subject and body of an email and the body of a message, up to the longest the send tools draft', () => {
    expect(appApprovalV1Schema.safeParse(mailDraft).success).toBe(true);
    expect(appApprovalV1Schema.safeParse(messageDraft).success).toBe(true);
    expect(appApprovalV1Schema.safeParse(withMessage(email, { subject: 'x'.repeat(200), body: 'x'.repeat(10_000) })).success).toBe(true);
    expect(appApprovalV1Schema.safeParse(withMessage(message, { subject: null, body: 'x'.repeat(4_096) })).success).toBe(true);
    expect(appApprovalV1Schema.safeParse(withMessage(email, { subject: 'Friday', body: ' \n ' })).success).toBe(true);
  });

  it.each([
    ['an email without its subject', email, { subject: null, body: 'See you at 4.' }],
    ['a message with a subject', message, { subject: 'Hi', body: 'Running late.' }],
    ['an empty body', email, { subject: 'Friday', body: '' }],
    ['an empty subject', email, { subject: '', body: 'See you at 4.' }],
    ['a subject that breaks the header line', email, { subject: 'Friday\r\nBcc: x@example.com', body: 'See you at 4.' }],
    ['a body over the reply limit', email, { subject: 'Friday', body: 'x'.repeat(32_001) }],
    ['a body missing', email, { subject: 'Friday' }],
    ['a truncation flag', email, { subject: 'Friday', body: 'See you', truncated: true }],
    ['attachments', email, { subject: 'Friday', body: 'See you at 4.', attachments: [] }],
    ['a draft on a calendar change', calendar, { subject: null, body: 'Move it.' }],
    ['a draft on a browser action', browser, { subject: null, body: 'Book it.' }],
    ['a draft on an MCP call', mcp, { subject: null, body: 'Run it.' }],
    ['a draft on a task change', task, { subject: null, body: 'Buy oat milk.' }],
  ] as const)('rejects %s', (_shape, approval, draft) => {
    expect(appApprovalV1Schema.safeParse(withMessage(approval, draft)).success).toBe(false);
  });

  it('a build reading revision 1 or 2 gets exactly the shape before the draft, and a revision 3 build gets the same object', () => {
    expect(APP_APPROVALS_CONTRACT_REVISION).toBe(6);
    for (const [draft, before] of [[mailDraft, email], [messageDraft, message]] as const) {
      const parsed = appApprovalV1Schema.parse(draft) as AppApprovalV1;
      for (const revision of [1, 2]) expect([revision, JSON.stringify(appApprovalAtRevision(parsed, revision))]).toEqual([revision, JSON.stringify(before)]);
      expect(appApprovalAtRevision(parsed, 3)).toBe(parsed);
    }
    const detailed = appApprovalV1Schema.parse({ ...calendar, exact: { changes: { ...calendar.exact.changes, time_zone: 'Europe/London' } } }) as AppApprovalV1;
    expect(appApprovalAtRevision(detailed, 2)).toBe(detailed);
    expect(appApprovalAtRevision(detailed, 3)).toBe(detailed);
  });
});

describe('the health origin of an approval, approvals revision 4', () => {
  const health = { reason: 'A short night, so a gentler start to the day.' };
  const marked = { ...calendar, health };

  it('accepts the one-line reason a health trigger gave, up to the longest a proposal can carry', () => {
    expect(appApprovalV1Schema.safeParse(marked).success).toBe(true);
    expect(appApprovalV1Schema.safeParse({ ...calendar, health: { reason: 'x'.repeat(300) } }).success).toBe(true);
  });

  it.each([
    ['an empty reason', { reason: '' }],
    ['a reason past what a proposal can carry', { reason: 'x'.repeat(301) }],
    ['no reason', {}],
    ['a score beside the reason', { reason: 'A short night.', score: 41 }],
    ['a zone beside the reason', { reason: 'A short night.', zone: 'low' }],
    ['a reason that is not text', { reason: 3 }],
  ] as const)('rejects %s', (_shape, value) => {
    expect(appApprovalV1Schema.safeParse({ ...calendar, health: value }).success).toBe(false);
  });

  it('a build reading revision 3 or below gets exactly the shape before it, and a revision 4 build gets the same object', () => {
    const parsed = appApprovalV1Schema.parse(marked) as AppApprovalV1;
    for (const revision of [1, 2, 3]) expect([revision, JSON.stringify(appApprovalAtRevision(parsed, revision))]).toEqual([revision, JSON.stringify(calendar)]);
    expect(appApprovalAtRevision(parsed, 4)).toBe(parsed);
    expect(JSON.stringify(parsed)).toContain('"health"');
  });

  it('strips the marker together with the details and the draft an older revision also leaves out', () => {
    const detailed = appApprovalV1Schema.parse({ ...marked, exact: { changes: { ...calendar.exact.changes, time_zone: 'Europe/London', location: 'Studio' } } }) as AppApprovalV1;
    expect(JSON.stringify(appApprovalAtRevision(detailed, 1))).toBe(JSON.stringify(calendar));
    const atThree = appApprovalAtRevision(detailed, 3);
    expect(atThree.health).toBeUndefined();
    expect(atThree.exact.changes?.time_zone).toBe('Europe/London');
    const mail = appApprovalV1Schema.parse({ ...email, health }) as AppApprovalV1;
    expect(JSON.stringify(appApprovalAtRevision(mail, 3))).toBe(JSON.stringify(email));
  });

  it('an approval without the marker is returned as it is at every revision', () => {
    const plain = appApprovalV1Schema.parse(calendar) as AppApprovalV1;
    for (const revision of [2, 3, 4, 5]) expect(appApprovalAtRevision(plain, revision)).toBe(plain);
  });

  it('serves the marker in a list only as the schema allows', () => {
    expect(appApprovalListV1Schema.safeParse({ approvals: [marked, email] }).success).toBe(true);
    expect(appApprovalListV1Schema.safeParse({ approvals: [{ ...marked, health: { reason: '' } }] }).success).toBe(false);
  });
});

describe('a send as Waldo, approvals revision 6', () => {
  const sender = { name: "Waldo, Sam's assistant", address: 'sam@mail.example.com' };
  const asWaldo = {
    ...email, approval_id: 'p0007', kind: 'agent_mail_send', review: `From: ${sender.name} <${sender.address}>\nTo: lee@example.com\nSubject: Friday\n\nSee you at 4.`,
    exact: { recipients: { to: ['lee@example.com'], cc: [], bcc: [] }, sender, message: { subject: 'Friday', body: 'See you at 4.' } },
  } as const;

  it('accepts a send that names its sender, its recipients and its draft', () => {
    expect(APP_APPROVALS_AGENT_MAIL_REVISION).toBe(6);
    expect(appApprovalV1Schema.safeParse(asWaldo).success).toBe(true);
    const { message: _draft, ...withoutDraft } = asWaldo.exact;
    expect(appApprovalV1Schema.safeParse({ ...asWaldo, exact: withoutDraft }).success).toBe(true);
    expect(appApprovalListV1Schema.safeParse({ approvals: [asWaldo, email] }).success).toBe(true);
  });

  it.each([
    ['no sender', { ...asWaldo, exact: { recipients: asWaldo.exact.recipients } }],
    ['no recipients', { ...asWaldo, exact: { sender } }],
    ['a sender on a Gmail send', { ...email, exact: { ...email.exact, sender } }],
    ['a sender on a message', { ...message, exact: { ...message.exact, sender } }],
    ['a sender name that breaks its line', { ...asWaldo, exact: { ...asWaldo.exact, sender: { ...sender, name: 'Waldo\r\nBcc: x@example.com' } } }],
    ['an empty sender name', { ...asWaldo, exact: { ...asWaldo.exact, sender: { ...sender, name: '' } } }],
    ['a sender that is not an address', { ...asWaldo, exact: { ...asWaldo.exact, sender: { ...sender, address: 'waldo' } } }],
    ['a sender with more than its name and address', { ...asWaldo, exact: { ...asWaldo.exact, sender: { ...sender, reply_to: 'x@example.com' } } }],
    ['a draft without its subject', { ...asWaldo, exact: { ...asWaldo.exact, message: { subject: null, body: 'See you at 4.' } } }],
  ] as const)('rejects %s', (_shape, approval) => {
    expect(appApprovalV1Schema.safeParse(approval).success).toBe(false);
  });
});
