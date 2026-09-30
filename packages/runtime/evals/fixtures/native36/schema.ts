import { createHash } from 'node:crypto';

export type Owner = 'candidate' | 'control';
export type CalendarEvent = { id: string; title: string; start: string; end: string; timezone: 'Asia/Kolkata'; revision: number; status: 'confirmed' | 'cancelled'; flexibility: 'fixed' | 'flexible' | 'protected' };
export type MailMessage = { id: string; thread_id: string; at: string; from: string; to: string; subject: string; body: string };
export type Attachment = { id: string; revision: string; media_type: string; bytes: string; digest: string };
export type Source =
  | { kind: 'calendar'; id: string; events: CalendarEvent[]; free: { start: string; end: string }[] }
  | { kind: 'mail'; id: string; thread_id: string; messages: MailMessage[] }
  | { kind: 'document'; id: string; revision: string; dated: string; bytes: string; digest: string }
  | { kind: 'attachment'; id: string; attachment: Attachment }
  | { kind: 'tasks'; id: string; items: { id: string; title: string; duration_minutes: number; deadline: string; commitment: 'promised' | 'internal'; reducible: boolean; status: 'open'; restart_context: string }[] }
  | { kind: 'availability'; id: string; minutes: number; windows: { start: string; end: string }[] }
  | { kind: 'priorities'; id: string; items: { id: string; title: string; required_minutes: number | null; status: 'open' }[] }
  | { kind: 'owner_statement'; id: string; at: string; bytes: string }
  | { kind: 'health_projection'; id: string; at: string; freshness: 'fresh'; energy: 'low'; shareable: false };
export type Canary = { id: string; category: 'private_health' | 'messages_window' | 'project_b' | 'cross_owner'; marker: string; bytes: string };
export type SendInput = { thread_id: string; recipient: string; subject: string; body: string; attachments: Attachment[] };
export type OwnerInput = { id: string; at: string; origin: 'authored_synthetic_owner_input'; words: string; binding: null | { kind: 'calendar_moves'; moves: { event_id: string; expected_revision: number; start: string; end: string }[] } | { kind: 'mail_send'; message: SendInput } | { kind: 'watch_cancel'; thread_id: string } };
export type Branch = { id: string; owner_inputs: OwnerInput[]; reply_after_send_ms: number | null; reply: MailMessage | null; cancel_after_send_ms: number | null };
export type Fixture = {
  schema_version: 1; case_id: string; suite_hash: string; baseline_head: string;
  now: string; timezone: 'Asia/Kolkata'; visible_prompt: string; pinned_facts: string[];
  authored_values: string; permitted_source_ids: string[]; sources: Record<Owner, Source[]>;
  canaries: Record<Owner, Canary[]>; branches: Branch[];
};
export const digest = (value: string): string => `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
export const fixtureDigest = (fixture: Fixture): string => digest(JSON.stringify(fixture));
const fail = (piece: string): never => { throw new Error(`harness_error: invalid fixture ${piece}`); };
export const time = (value: string): number => {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail('timestamp');
  return parsed;
};
const text = (value: unknown, name: string): void => { if (typeof value !== 'string' || !value.length) fail(name); };
const unique = (ids: string[], name: string): void => { if (new Set(ids).size !== ids.length || ids.some(id => !id)) fail(name); };
export const validateEvent = (event: CalendarEvent): void => {
  text(event.id, 'event id'); text(event.title, 'event title');
  if (time(event.start) >= time(event.end) || event.timezone !== 'Asia/Kolkata' || !Number.isInteger(event.revision) || event.revision < 1 || !['confirmed','cancelled'].includes(event.status) || !['fixed','flexible','protected'].includes(event.flexibility)) fail('calendar event');
};
export const validateAttachment = (file: Attachment): void => {
  for (const key of ['id','revision','media_type','bytes'] as const) text(file[key], `attachment ${key}`);
  if (file.digest !== digest(file.bytes)) fail('attachment digest');
};
export const validateMail = (message: MailMessage): void => {
  for (const key of ['id','thread_id','from','to','subject','body'] as const) text(message[key], `mail ${key}`);
  time(message.at);
};
export const validateSend = (message: SendInput): void => {
  for (const key of ['thread_id','recipient','subject','body'] as const) text(message[key], `send ${key}`);
  if (!Array.isArray(message.attachments)) fail('send attachments');
  unique(message.attachments.map(a => a.id), 'attachment identities');
  message.attachments.forEach(validateAttachment);
};
export const validateFixture = (fixture: Fixture): void => {
  if (fixture.schema_version !== 1 || fixture.timezone !== 'Asia/Kolkata') fail('schema version/timezone');
  for (const key of ['case_id','suite_hash','baseline_head','visible_prompt','authored_values'] as const) text(fixture[key], key);
  time(fixture.now);
  if (!Array.isArray(fixture.pinned_facts) || !fixture.pinned_facts.length) fail('pinned facts');
  fixture.pinned_facts.forEach(f => text(f, 'pinned fact'));
  unique(fixture.permitted_source_ids, 'permitted sources');
  for (const owner of ['candidate','control'] as const) {
    const rows = fixture.sources[owner];
    if (!Array.isArray(rows) || !rows.length || !Array.isArray(fixture.canaries[owner])) fail('two owner stores');
    unique(rows.map(s => s.id), 'source identities');
    unique(fixture.canaries[owner].map(s => s.id), 'canary identities');
    for (const source of rows) {
      switch (source.kind) {
        case 'calendar': unique(source.events.map(e => e.id), 'event identities'); source.events.forEach(validateEvent); source.free.forEach(w => { if (time(w.start) >= time(w.end)) fail('free window'); }); break;
        case 'mail': text(source.thread_id, 'thread id'); unique(source.messages.map(m => m.id), 'message identities'); source.messages.forEach(m => { validateMail(m); if (m.thread_id !== source.thread_id) fail('thread binding'); }); break;
        case 'document': text(source.bytes, 'document bytes'); text(source.revision, 'document revision'); time(source.dated); if (source.digest !== digest(source.bytes)) fail('document digest'); break;
        case 'attachment': validateAttachment(source.attachment); break;
        case 'tasks': unique(source.items.map(t => t.id), 'task identities'); source.items.forEach(t => { text(t.title, 'task title'); text(t.restart_context, 'restart context'); time(t.deadline); if (!Number.isInteger(t.duration_minutes) || t.duration_minutes <= 0 || t.status !== 'open' || typeof t.reducible !== 'boolean' || !['promised','internal'].includes(t.commitment)) fail('task'); }); break;
        case 'availability': source.windows.forEach(w => { if (time(w.start) >= time(w.end)) fail('availability window'); }); if (!Number.isInteger(source.minutes) || source.minutes <= 0 || source.windows.reduce((n, w) => n + (time(w.end) - time(w.start)) / 60000, 0) !== source.minutes) fail('availability'); break;
        case 'priorities': unique(source.items.map(i => i.id), 'priority identities'); source.items.forEach(i => { text(i.title, 'priority title'); if (i.status !== 'open' || (i.required_minutes !== null && (!Number.isInteger(i.required_minutes) || i.required_minutes <= 0))) fail('priority'); }); break;
        case 'owner_statement': time(source.at); text(source.bytes, 'owner statement'); break;
        case 'health_projection': time(source.at); if (source.freshness !== 'fresh' || source.energy !== 'low' || source.shareable !== false) fail('health projection'); break;
        default: fail('unknown source kind');
      }
    }
    for (const canary of [...fixture.canaries.candidate,...fixture.canaries.control]) {
      text(canary.bytes, 'canary bytes'); text(canary.marker, 'canary marker');
      if (rows.some(s => s.id === canary.id || JSON.stringify(s).includes(canary.marker) || JSON.stringify(s).includes(canary.bytes))) fail('canary leakage');
    }
    if (fixture.permitted_source_ids.some(id => !rows.some(s => s.id === id))) fail('missing permitted source');
  }
  unique(fixture.branches.map(b => b.id), 'branch identities');
  if (!fixture.branches.length) fail('branches');
  for (const branch of fixture.branches) {
    unique(branch.owner_inputs.map(i => i.id), 'owner input identities');
    for (const input of branch.owner_inputs) {
      text(input.words, 'owner input words');
      if (input.origin !== 'authored_synthetic_owner_input' || time(input.at) < time(fixture.now)) fail('owner input time/origin');
      if (input.binding?.kind === 'mail_send') validateSend(input.binding.message);
      if (input.binding?.kind === 'calendar_moves') {
        unique(input.binding.moves.map(m => m.event_id), 'move identities');
        for (const move of input.binding.moves) if (time(move.start) >= time(move.end) || !Number.isInteger(move.expected_revision) || move.expected_revision < 1) fail('move binding');
      }
    }
    if ((branch.reply === null) !== (branch.reply_after_send_ms === null)) fail('reply schedule');
    if (branch.reply) validateMail(branch.reply);
    for (const delay of [branch.reply_after_send_ms, branch.cancel_after_send_ms]) if (delay !== null && (!Number.isInteger(delay) || delay <= 0)) fail('schedule delay');
  }
};
