import { isStepUpRefusal, SignInRequired, StepUpRequired } from './model';

export type ControlsView = 'day' | 'connections' | 'waiting' | 'activity' | 'profile' | 'setup' | 'usage' | 'files' | 'imessage' | 'devices' | 'phone';
type Base<V extends ControlsView, D> = { version: 1; view: V; state: 'available'; csrf: string; revision: string; data: D };
export type DayRecord = Base<'day', {
  timezone: string;
  date: string;
  cards: { id: string; name: string; defaultTime: string; time: string | null; reason: string; sent: boolean; pin: string | null }[];
  proactivity: { quiet_start: string | null; quiet_end: string | null; volume: 'low' | 'normal' | 'high' };
  // Where Waldo's proactive messages go, and where the owner can be reached now. Absent from a Worker that does not say.
  proactive_surface?: ProactiveSurface;
  // Whether notes Waldo keeps on its own include health. Absent from a Worker that does not say.
  health_memory?: boolean;
}>;
export type ProactiveSurface = { value: 'app' | 'whatsapp' | 'both' | 'app_imessage'; app_linked: boolean; whatsapp_linked: boolean; imessage_linked?: boolean; telegram_linked: boolean };
export type ConnectionsRecord = Base<'connections', {
  google: { connectAvailable: boolean; accounts: { id: string; email: string; calendar: boolean; mail: boolean; tasks: boolean; health: 'access_granted' | 'needs_reconnect' }[] };
  telegram: { linked: boolean; unlinkAvailable: boolean };
  sessions: { until: string; count: number; items: { signed_in: string; until: string; current: boolean }[] };
  channels?: { channel: 'telegram' | 'whatsapp' | 'imessage'; state: 'linked' | 'blocked' | 'pending' | 'unlinked'; masked_label: string | null }[];
  mcp?: McpServerRecord[];
}>;
// A remote MCP server the owner connected. Titles are the server's own text; read_only_hint is its claim.
export type McpServerRecord = { id: string; name: string; host: string; server_url: string; auth: 'oauth' | 'none'; status: 'active' | 'reauth_needed'; scopes: string[]; wants_scopes: string[]; tools: number; hidden_tools: number; runs_without_asking: number; marked_read_only: number; tools_changed: boolean; tools_capped: boolean; read_only_digest: string; tool_list: { tool: string; runs: 'without_asking' | 'asks_first'; read_only_hint: boolean; title?: string; digest: string }[] };
export type ProposalReview = { kind: 'email_send'; account?: string; to: string[]; cc: string[]; bcc: string[]; subject: string; body: string; earlier_unknown_at?: string }
  | { kind: 'message_send'; channel: string; content: string }
  | { kind: 'mcp_call' | 'tainted_action' | 'browser_submit'; text: string }
  | { kind: 'calendar_change'; action: 'create' | 'move' | 'cancel'; title: string | null; event_id: string | null; start: string | null; end: string | null; reason: string };
export type WaitingRecord = Base<'waiting', { timezone: string | null; proposals: { id: string; kind: string; summary: string; state: 'open' | 'done' | 'unconfirmed' | 'review_only'; review: ProposalReview | null; actions: ('approval.approve' | 'approval.send' | 'approval.edit' | 'approval.skip' | 'approval.undo')[] }[] }>;
export type ActivityCursors = { trace_before?: number | null; runs_before?: number | null };
export type LastRequest = { at: string; ok: boolean; partial: boolean; recorded_steps: number; hops: { hop: string; ok: boolean; ms: number; note: string }[] };
export type ActivityRecord = Base<'activity', {
  last_request: LastRequest | null;
  steps: { step: string; state: 'ok' | 'failed' | 'unseen'; at: string | null; note: string | null }[];
  trace: { time: string; hop: string; ok: boolean; ms: number; summary: string | null }[];
  runs: { id: string; kind: string; status: string; summary: string | null; started: string; ended: string | null }[];
  page: { trace_before: number | null; runs_before: number | null; trace_applied: number | null; runs_applied: number | null };
  ledger: string;
}>;
export type ProfileRecord = Base<'profile', { sections: { title: string; lines: string[] }[]; barriers: number; removal: { state: 'incomplete' | 'none_recorded'; pending_count: number; items?:{id:string;status:'purging'}[] }; holds: { kind: string; reason: string; created_at: string }[] }>;
export type SetupRecord = Base<'setup', { telegram_linked: boolean; google_access_granted: boolean; quiet_hours_set: boolean; imessage_linked?: boolean }>;
export type UsageRecord = Base<'usage', { rows: { model: string; calls: number; input: number; cached: number; output: number; usd: number }[] }>;
export type FilesRecord = Base<'files', { storage: 'telegram_reference'; items: { id: number; kind: string; name: string; mime: string | null; size: number | null; caption: string; at: number }[] }>;
const IMESSAGE_TOP = ['imessage.enroll', 'imessage.link', 'imessage.unlink', 'imessage.pair', 'imessage.pair_shared'] as const, IMESSAGE_ROW = ['imessage.verify', 'imessage.activate', 'imessage.activate_shared', 'imessage.revoke'] as const;
const DEVICE_ROW = ['device.revoke', 'device.query', 'device.notify'] as const;
// Liveness sits beside data: it is not part of the revision, so it can change between reads without blocking a decision.
export type IMessageRecord = Base<'imessage', {
  enabled: boolean; address: string | null; linked_hint: string | null; admin: boolean; phone: string | null; photon: 'connected' | 'disconnected' | null; actions: (typeof IMESSAGE_TOP)[number][];
  phone_on_file: { phone: string; verified: boolean } | null;
  bridges: { id: string; kind: 'owner' | 'shared'; state: string; subject: string | null; chat: string | null; observed: boolean; host_version: string; actions: (typeof IMESSAGE_ROW)[number][] }[];
}> & { status: { bridges: { id: string; online: boolean; text_ready: boolean; sending_paused: boolean }[] } };
export type DevicesRecord = Base<'devices', {
  actions: 'device.pair'[]; devices: { id: string; label: string; capabilities: string[]; created_at: string; actions: (typeof DEVICE_ROW)[number][] }[]; query_kinds: string[]; notification_bodies: string[];
}> & { status: { devices: { id: string; online: boolean; last_seen_at: string | null; commands: { class: string; state: string; result_state: string | null }[] }[] } };
const PHONE_ACTIONS = ['phone.sms_send', 'phone.sms_check'] as const, PHONE_STATES = ['sending', 'pending', 'checking', 'approved', 'expired', 'unknown'] as const;
/** The number on file and how to prove it. Times are epoch seconds; retry_at null means a code may be asked for now. */
export type PhoneRecord = Base<'phone', {
  phone: string | null; verified: boolean; sms: boolean; actions: (typeof PHONE_ACTIONS)[number][];
  challenge: { state: (typeof PHONE_STATES)[number]; expires_at: number; retry_at: number | null; checks_left: number } | null;
}>;
type Records = { day: DayRecord; connections: ConnectionsRecord; waiting: WaitingRecord; activity: ActivityRecord; profile: ProfileRecord; setup: SetupRecord; usage: UsageRecord; files: FilesRecord; imessage: IMessageRecord; devices: DevicesRecord; phone: PhoneRecord };
export type ControlRecord = Records[ControlsView];
export type ControlAction = 'spot.confirm' | 'spot.dismiss' | 'spot.forget' | 'spot.pin' | 'spot.unpin' | 'spot.edit' | 'node.forget' | 'card.today' | 'card.pin' | 'card.unpin' | 'timezone.set' | 'proactivity.set' | 'proactive_surface.set' | 'health_memory.set' | 'google.connect' | 'google.disconnect' | 'telegram.link' | 'telegram.unlink' | 'whatsapp.link' | 'whatsapp.unlink' | 'session.signout' | 'session.signout.all' | 'approval.approve' | 'approval.send' | 'approval.edit' | 'approval.skip' | 'approval.undo' | 'file.remove' | 'mcp.connect' | 'mcp.disconnect' | 'mcp.runs'
  | (typeof IMESSAGE_TOP)[number] | (typeof IMESSAGE_ROW)[number] | 'device.pair' | (typeof DEVICE_ROW)[number] | (typeof PHONE_ACTIONS)[number];
export type ControlFields = { id?: string; value?: string; quiet_start?: string; quiet_end?: string; volume?: string; subject?: string; chat?: string; phone?: string; query_kind?: string; body?: string; severity?: string; code?: string };
export type ActionReceipt = { state: 'recorded' | 'incomplete' | 'rejected' | 'unconfirmed'; message: string; navigation?: string; signed_out?: boolean };
// A code or challenge shown once with its receipt. It lives only in component state: never in a URL, history or storage.
/** to: where a link code is texted (a phone number or Apple ID address), when the server names it. */
export type ActionReveal = { kind: 'link_code' | 'host_code' | 'challenge' | 'pairing_code'; value: string; to?: string };
export type ActionResult = { receipt: ActionReceipt; duplicate: boolean; reveal?: ActionReveal };
export class ControlsActionError extends Error {
  constructor(readonly code: string, message: string, readonly uncertain = false) { super(message); }
}
const obj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const string = (v: unknown): v is string => typeof v === 'string';
const clock = (v: unknown): v is string => string(v) && /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(v);
const optionalClock = (v: unknown): v is string | null => v === null || clock(v);
const optionalString = (v: unknown): v is string | null => v === null || string(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(string);
const count = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const cursor = (v: unknown): v is number | null => v === null || count(v) && v > 0;
const shapeError = () => new Error('These controls are unavailable or their read is unsupported. Refresh the records.');
const listed = (v: unknown, known: readonly string[]): v is string[] => strings(v) && v.every(item => known.includes(item)) && new Set(v).size === v.length;

function readProposalReview(value: unknown): ProposalReview | null {
  if (value === null) return null;
  if (!obj(value)) throw shapeError();
  if (value.kind === 'email_send' && (value.account === undefined || string(value.account)) && strings(value.to) && strings(value.cc) && strings(value.bcc) && string(value.subject) && string(value.body) && (value.earlier_unknown_at === undefined || string(value.earlier_unknown_at)))
    return { kind: value.kind, ...(value.account === undefined ? {} : { account: value.account }), to: [...value.to], cc: [...value.cc], bcc: [...value.bcc], subject: value.subject, body: value.body, ...(value.earlier_unknown_at === undefined ? {} : { earlier_unknown_at: value.earlier_unknown_at }) };
  if (value.kind === 'message_send' && string(value.channel) && string(value.content)) return { kind: value.kind, channel: value.channel, content: value.content };
  if ((value.kind === 'mcp_call' || value.kind === 'tainted_action' || value.kind === 'browser_submit') && string(value.text)) return { kind: value.kind, text: value.text };
  if (value.kind === 'calendar_change' && ['create', 'move', 'cancel'].includes(String(value.action)) && [value.title, value.event_id, value.start, value.end].every(optionalString) && string(value.reason)) return { kind: value.kind, action: value.action as 'create' | 'move' | 'cancel', title: value.title as string | null, event_id: value.event_id as string | null, start: value.start as string | null, end: value.end as string | null, reason: value.reason };
  throw shapeError();
}

const validZone = (zone: string) => { try { new Intl.DateTimeFormat('en', { timeZone: zone }); return true; } catch { return false; } };
export function readControls<V extends ControlsView>(value: unknown, expected: V): Records[V] {
  if (!obj(value) || value.version !== 1 || value.view !== expected || value.state !== 'available' || !string(value.csrf) || !value.csrf || !string(value.revision) || !/^[a-f0-9]{64}$/.test(value.revision) || !obj(value.data)) throw shapeError();
  const data = value.data;
  const base = { version: 1 as const, state: 'available' as const, csrf: value.csrf, revision: value.revision };
  if (expected === 'day') {
    if (!string(data.timezone) || !string(data.date) || !/^\d{4}-\d{2}-\d{2}$/.test(data.date) || !Array.isArray(data.cards) || !data.cards.every(card => obj(card) && string(card.id) && string(card.name) && clock(card.defaultTime) && optionalClock(card.time) && string(card.reason) && typeof card.sent === 'boolean' && optionalClock(card.pin)) || !obj(data.proactivity) || !optionalClock(data.proactivity.quiet_start) || !optionalClock(data.proactivity.quiet_end) || !['low', 'normal', 'high'].includes(String(data.proactivity.volume))) throw shapeError();
    const surface = data.proactive_surface;
    if (surface !== undefined && (!obj(surface) || !['app', 'whatsapp', 'both', 'app_imessage'].includes(String(surface.value)) || ![surface.app_linked, surface.whatsapp_linked, surface.telegram_linked].every(value => typeof value === 'boolean') || (surface.imessage_linked !== undefined && typeof surface.imessage_linked !== 'boolean'))) throw shapeError();
    if (data.health_memory !== undefined && typeof data.health_memory !== 'boolean') throw shapeError();
    return { ...base, view: 'day', data: {
      timezone: data.timezone,
      date:data.date,
      cards: data.cards.map(card => ({ id: card.id, name: card.name, defaultTime: card.defaultTime, time: card.time, reason: card.reason, sent: card.sent, pin: card.pin })),
      proactivity: { quiet_start: data.proactivity.quiet_start, quiet_end: data.proactivity.quiet_end, volume: data.proactivity.volume },
      ...(obj(surface) ? { proactive_surface: { value: surface.value, app_linked: surface.app_linked, whatsapp_linked: surface.whatsapp_linked, ...(surface.imessage_linked === undefined ? {} : { imessage_linked: surface.imessage_linked }), telegram_linked: surface.telegram_linked } } : {}),
      ...(typeof data.health_memory === 'boolean' ? { health_memory: data.health_memory } : {}),
    } } as Records[V];
  }
  if (expected === 'connections') {
    if (!obj(data.google) || typeof data.google.connectAvailable !== 'boolean' || !Array.isArray(data.google.accounts) || !data.google.accounts.every(account => obj(account) && string(account.id) && string(account.email) && ['calendar', 'mail', 'tasks'].every(key => typeof account[key] === 'boolean') && ['access_granted', 'needs_reconnect'].includes(String(account.health))) || !obj(data.telegram) || typeof data.telegram.linked !== 'boolean' || typeof data.telegram.unlinkAvailable !== 'boolean' || !obj(data.sessions) || !string(data.sessions.until) || !Number.isSafeInteger(data.sessions.count) || Number(data.sessions.count) < 1 || !Array.isArray(data.sessions.items) || !data.sessions.items.every(item => obj(item) && string(item.signed_in) && string(item.until) && typeof item.current === 'boolean')
      || (data.channels !== undefined && (!Array.isArray(data.channels) || !data.channels.every(item => obj(item) && ['telegram', 'whatsapp', 'imessage'].includes(String(item.channel)) && ['linked', 'blocked', 'pending', 'unlinked'].includes(String(item.state)) && optionalString(item.masked_label))))
      || (data.mcp !== undefined && (!Array.isArray(data.mcp) || !data.mcp.every(mcpServer)))) throw shapeError();
    return { ...base, view: 'connections', data: {
    google: { connectAvailable: data.google.connectAvailable, accounts: data.google.accounts.map(account => ({ id: account.id, email: account.email, calendar: account.calendar, mail: account.mail, tasks: account.tasks, health: account.health })) },
    telegram: { linked: data.telegram.linked, unlinkAvailable: data.telegram.unlinkAvailable },
    sessions: { until: data.sessions.until, count: data.sessions.count, items: (data.sessions.items as { signed_in: string; until: string; current: boolean }[]).map(item => ({ signed_in: item.signed_in, until: item.until, current: item.current })) },
    ...(data.channels === undefined ? {} : { channels: (data.channels as NonNullable<ConnectionsRecord['data']['channels']>).map(item => ({ channel: item.channel, state: item.state, masked_label: item.masked_label })) }),
    ...(data.mcp === undefined ? {} : { mcp: (data.mcp as McpServerRecord[]).map(server => ({ id: server.id, name: server.name, host: server.host, server_url: server.server_url, auth: server.auth, status: server.status, scopes: [...server.scopes], wants_scopes: [...server.wants_scopes], tools: server.tools, hidden_tools: server.hidden_tools, runs_without_asking: server.runs_without_asking, marked_read_only: server.marked_read_only, tools_changed: server.tools_changed, tools_capped: server.tools_capped, read_only_digest: server.read_only_digest, tool_list: server.tool_list.map(tool => ({ tool: tool.tool, runs: tool.runs, read_only_hint: tool.read_only_hint, ...(tool.title === undefined ? {} : { title: tool.title }), digest: tool.digest })) })) }),
    } } as Records[V];
  }
  if (expected === 'waiting') {
    if (!Array.isArray(data.proposals)) throw shapeError();
    // An absent or unreadable zone is carried as null; the panel then says its illustration is in UTC.
    const timezone = string(data.timezone) && validZone(data.timezone) ? data.timezone : null;
    const proposals = data.proposals.map(item => {
      if (!obj(item) || !string(item.id) || !string(item.kind) || !string(item.summary) || !['open', 'done', 'unconfirmed', 'review_only'].includes(String(item.state)) || !strings(item.actions) || !item.actions.every(action => ['approval.approve', 'approval.send', 'approval.edit', 'approval.skip', 'approval.undo'].includes(action))) throw shapeError();
      const review = readProposalReview(item.review);
      // Send and Change it need the open draft itself on the page; approving a calendar change needs its change.
      const draft = item.state === 'open' && (item.kind === 'email_send' || item.kind === 'message_send') && review?.kind === item.kind;
      if (review && review.kind !== item.kind || item.actions.includes('approval.approve') && (item.kind !== 'calendar_change' || item.state !== 'open' || review?.kind !== 'calendar_change')
        || (item.actions.includes('approval.send') || item.actions.includes('approval.edit')) && !draft || item.actions.includes('approval.undo') && (item.kind !== 'calendar_change' || item.state !== 'done')) throw shapeError();
      return { id: item.id, kind: item.kind, summary: item.summary, state: item.state, review, actions: [...item.actions] };
    });
    return { ...base, view: 'waiting', data: { timezone, proposals } } as Records[V];
  }
  if (expected === 'activity') {
    if (!(data.last_request === null || obj(data.last_request) && string(data.last_request.at) && typeof data.last_request.ok === 'boolean' && typeof data.last_request.partial === 'boolean' && Number.isSafeInteger(data.last_request.recorded_steps) && Array.isArray(data.last_request.hops) && data.last_request.hops.every(hop => obj(hop) && string(hop.hop) && typeof hop.ok === 'boolean' && finite(hop.ms) && typeof hop.note === 'string')) || !Array.isArray(data.steps) || !data.steps.every(row => obj(row) && string(row.step) && ['ok', 'failed', 'unseen'].includes(String(row.state)) && optionalString(row.at) && optionalString(row.note)) || !Array.isArray(data.trace) || !data.trace.every(row => obj(row) && string(row.time) && string(row.hop) && typeof row.ok === 'boolean' && finite(row.ms) && optionalString(row.summary)) || !Array.isArray(data.runs) || !data.runs.every(row => obj(row) && string(row.id) && string(row.kind) && string(row.status) && optionalString(row.summary) && string(row.started) && optionalString(row.ended)) || !obj(data.page) || ![data.page.trace_before, data.page.runs_before, data.page.trace_applied, data.page.runs_applied].every(cursor) || !string(data.ledger)) throw shapeError();
    const lastRequest = data.last_request as { at: string; ok: boolean; partial: boolean; recorded_steps: number; hops: { hop: string; ok: boolean; ms: number; note: string }[] } | null;
    return { ...base, view: 'activity', data: {
      last_request: lastRequest && { at: lastRequest.at, ok: lastRequest.ok, partial: lastRequest.partial, recorded_steps: lastRequest.recorded_steps, hops: lastRequest.hops.map(hop => ({ hop: hop.hop, ok: hop.ok, ms: hop.ms, note: hop.note })) },
      steps: data.steps.map(row => ({ step: row.step, state: row.state, at: row.at, note: row.note })), trace: data.trace.map(row => ({ time: row.time, hop: row.hop, ok: row.ok, ms: row.ms, summary: row.summary })),
      runs: data.runs.map(row => ({ id: row.id, kind: row.kind, status: row.status, summary: row.summary, started: row.started, ended: row.ended })),
      page: { trace_before: data.page.trace_before, runs_before: data.page.runs_before, trace_applied: data.page.trace_applied, runs_applied: data.page.runs_applied }, ledger: data.ledger,
    } } as Records[V];
  }
  if (expected === 'profile') {
    if (!Array.isArray(data.sections) || !data.sections.every(section => obj(section) && string(section.title) && strings(section.lines)) || !count(data.barriers) || !obj(data.removal) || !count(data.removal.pending_count) || !['incomplete', 'none_recorded'].includes(String(data.removal.state)) || !Array.isArray(data.holds) || !data.holds.every(hold => obj(hold) && string(hold.kind) && string(hold.reason) && string(hold.created_at))) throw shapeError();
    if (data.removal.state === 'incomplete' && (data.removal.pending_count === 0 || data.sections.length !== 0) || data.removal.state === 'none_recorded' && data.removal.pending_count !== 0) throw shapeError();
    if(data.removal.items!==undefined&&(!Array.isArray(data.removal.items)||!data.removal.items.every((item:unknown)=>obj(item)&&string(item.id)&&item.status==='purging')))throw shapeError();
    return { ...base, view: 'profile', data: { sections: data.sections.map(section => ({ title: section.title, lines: [...section.lines] })), barriers: data.barriers, removal: { state: data.removal.state, pending_count: data.removal.pending_count,items:Array.isArray(data.removal.items)?data.removal.items.filter((item:unknown)=>obj(item)&&string(item.id)&&item.status==='purging').map((item:{id:string})=>({id:item.id,status:'purging' as const})):[] }, holds: data.holds.map(hold => ({ kind: hold.kind, reason: hold.reason, created_at: hold.created_at })) } } as Records[V];
  }
  if (expected === 'setup') {
    if (![data.telegram_linked, data.google_access_granted, data.quiet_hours_set].every(value => typeof value === 'boolean')) throw shapeError();
    if (data.imessage_linked !== undefined && typeof data.imessage_linked !== 'boolean') throw shapeError();
    return { ...base, view: 'setup', data: { telegram_linked: data.telegram_linked, google_access_granted: data.google_access_granted, quiet_hours_set: data.quiet_hours_set,
      ...(data.imessage_linked !== undefined ? { imessage_linked: data.imessage_linked } : {}) } } as Records[V];
  }
  if (expected === 'usage') {
    if (!Array.isArray(data.rows) || !data.rows.every(row => obj(row) && string(row.model) && [row.calls, row.input, row.cached, row.output].every(count) && finite(row.usd))) throw shapeError();
    return { ...base, view: 'usage', data: { rows: data.rows.map(row => ({ model: row.model, calls: row.calls, input: row.input, cached: row.cached, output: row.output, usd: row.usd })) } } as Records[V];
  }
  if (expected === 'imessage') {
    const status = value.status;
    // phone, photon and phone_on_file are newer fields: a server without them reads as not enrollable, Photon unknown, number on file not known.
    const onFile = data.phone_on_file;
    if (typeof data.enabled !== 'boolean' || !optionalString(data.address) || !optionalString(data.linked_hint) || typeof data.admin !== 'boolean' || !listed(data.actions, IMESSAGE_TOP) || !Array.isArray(data.bridges)
      || (data.phone !== undefined && !optionalString(data.phone)) || (data.photon !== undefined && data.photon !== null && data.photon !== 'connected' && data.photon !== 'disconnected')
      || (onFile !== undefined && onFile !== null && !(obj(onFile) && string(onFile.phone) && typeof onFile.verified === 'boolean'))
      || !data.bridges.every(row => obj(row) && string(row.id) && /^imb_[0-9a-f]{32}$/.test(row.id) && ['owner', 'shared'].includes(String(row.kind)) && string(row.state) && optionalString(row.subject) && optionalString(row.chat) && typeof row.observed === 'boolean' && string(row.host_version) && listed(row.actions, IMESSAGE_ROW))
      || !obj(status) || !Array.isArray(status.bridges) || !status.bridges.every(row => obj(row) && string(row.id) && typeof row.online === 'boolean' && typeof row.text_ready === 'boolean' && typeof row.sending_paused === 'boolean')) throw shapeError();
    type Bridge = IMessageRecord['data']['bridges'][number];
    return { ...base, view: 'imessage', data: {
      enabled: data.enabled, address: data.address, linked_hint: data.linked_hint, admin: data.admin, phone: (data.phone ?? null) as string | null,
      photon: (data.photon ?? null) as IMessageRecord['data']['photon'], actions: [...data.actions] as IMessageRecord['data']['actions'],
      phone_on_file: obj(onFile) ? { phone: onFile.phone as string, verified: onFile.verified as boolean } : null,
      bridges: (data.bridges as Bridge[]).map(row => ({ id: row.id, kind: row.kind, state: row.state, subject: row.subject, chat: row.chat, observed: row.observed, host_version: row.host_version, actions: [...row.actions] })),
    }, status: { bridges: (status.bridges as IMessageRecord['status']['bridges']).map(row => ({ id: row.id, online: row.online, text_ready: row.text_ready, sending_paused: row.sending_paused })) } } as Records[V];
  }
  if (expected === 'devices') {
    const status = value.status;
    if (!listed(data.actions, ['device.pair']) || !strings(data.query_kinds) || !strings(data.notification_bodies) || !Array.isArray(data.devices)
      || !data.devices.every(row => obj(row) && string(row.id) && string(row.label) && strings(row.capabilities) && string(row.created_at) && listed(row.actions, DEVICE_ROW))
      || !obj(status) || !Array.isArray(status.devices) || !status.devices.every(row => obj(row) && string(row.id) && typeof row.online === 'boolean' && optionalString(row.last_seen_at) && Array.isArray(row.commands) && row.commands.every(command => obj(command) && string(command.class) && string(command.state) && optionalString(command.result_state)))) throw shapeError();
    type Device = DevicesRecord['data']['devices'][number];
    return { ...base, view: 'devices', data: {
      actions: [...data.actions] as DevicesRecord['data']['actions'], query_kinds: [...data.query_kinds], notification_bodies: [...data.notification_bodies],
      devices: (data.devices as Device[]).map(row => ({ id: row.id, label: row.label, capabilities: [...row.capabilities], created_at: row.created_at, actions: [...row.actions] })),
    }, status: { devices: (status.devices as DevicesRecord['status']['devices']).map(row => ({ id: row.id, online: row.online, last_seen_at: row.last_seen_at, commands: row.commands.map(command => ({ class: command.class, state: command.state, result_state: command.result_state })) })) } } as Records[V];
  }
  if (expected === 'phone') {
    const challenge = data.challenge;
    if (!(data.phone === null || (string(data.phone) && /^\+[1-9]\d{6,14}$/.test(data.phone))) || typeof data.verified !== 'boolean' || typeof data.sms !== 'boolean' || !listed(data.actions, PHONE_ACTIONS)
      || !(challenge === null || (obj(challenge) && (PHONE_STATES as readonly string[]).includes(String(challenge.state)) && count(challenge.expires_at)
        && (challenge.retry_at === null || count(challenge.retry_at)) && count(challenge.checks_left) && challenge.checks_left <= 5))) throw shapeError();
    type Challenge = NonNullable<PhoneRecord['data']['challenge']>;
    return { ...base, view: 'phone', data: { phone: data.phone, verified: data.verified, sms: data.sms, actions: [...data.actions] as PhoneRecord['data']['actions'],
      challenge: obj(challenge) ? { state: challenge.state as Challenge['state'], expires_at: challenge.expires_at as number, retry_at: challenge.retry_at as number | null, checks_left: challenge.checks_left as number } : null } } as Records[V];
  }
  if (expected === 'files') {
    if (data.storage !== 'telegram_reference' || !Array.isArray(data.items) || !data.items.every(item => obj(item) && count(item.id) && item.id > 0 && string(item.kind) && string(item.name) && optionalString(item.mime) && (item.size === null || count(item.size)) && string(item.caption) && typeof item.at === 'number' && Number.isFinite(item.at))) throw shapeError();
    return { ...base, view: 'files', data: { storage: 'telegram_reference', items: data.items.map(item => ({ id: item.id, kind: item.kind, name: item.name, mime: item.mime, size: item.size, caption: item.caption, at: item.at })) } } as Records[V];
  }
  throw shapeError();
}

export async function fetchControls<V extends ControlsView>(view: V, signal?: AbortSignal, page: ActivityCursors = {}): Promise<Records[V]> {
  const params = new URLSearchParams({ view });
  for (const key of ['trace_before', 'runs_before'] as const) {
    const value = page[key];
    if (value === null || value === undefined) continue;
    if (view !== 'activity' || !cursor(value)) throw shapeError();
    params.set(key, String(value));
  }
  const response = await fetch(`/console/dashboard/api/v1/controls?${params}`, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { accept: 'application/json' }, signal });
  if (response.status === 401) throw new SignInRequired();
  if (!response.ok) throw new Error('The controls could not be loaded. Retry the read; no empty state has been assumed.');
  let value: unknown;
  try { value = await response.json(); } catch { throw shapeError(); }
  return readControls(value, view);
}

const mcpServer = (item: unknown): boolean => obj(item) && string(item.id) && string(item.name) && string(item.host) && string(item.server_url) && ['oauth', 'none'].includes(String(item.auth)) && ['active', 'reauth_needed'].includes(String(item.status))
  && strings(item.scopes) && strings(item.wants_scopes) && ['tools', 'hidden_tools', 'runs_without_asking', 'marked_read_only'].every(key => count(item[key])) && typeof item.tools_changed === 'boolean' && typeof item.tools_capped === 'boolean'
  && digest(item.read_only_digest) && Array.isArray(item.tool_list) && item.tool_list.every(tool => obj(tool) && string(tool.tool) && ['without_asking', 'asks_first'].includes(String(tool.runs)) && typeof tool.read_only_hint === 'boolean' && (tool.title === undefined || typeof tool.title === 'string') && digest(tool.digest));
const digest = (value: unknown): boolean => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

// Existing connectUrl issues a first-party /c/<22-character ticket>. Direct
// Google authorization is constrained to the exact existing provider endpoint.
export function allowedControlNavigation(value: string, origin: string): string {
  let url: URL;
  try { url = new URL(value, origin); } catch { throw new ControlsActionError('navigation_unavailable', 'The connection link is unavailable. Refresh before connecting again.', true); }
  // An MCP connect continues on this deployment's own start link, which redirects only for the signed-in owner.
  const localTicket = url.origin === origin && (/^\/c\/[A-Za-z0-9_-]{22}$/.test(url.pathname) || /^\/console\/mcp\/start\/[A-Za-z0-9_-]{43}$/.test(url.pathname)) && !url.search && !url.hash;
  const google = url.hostname === 'accounts.google.com' && url.port === '' && url.pathname === '/o/oauth2/v2/auth' && !url.hash;
  if (url.protocol !== 'https:' || url.username || url.password || (!localTicket && !google)) throw new ControlsActionError('navigation_unavailable', 'The connection link is unavailable. Refresh before connecting again.', true);
  return url.href;
}

export function readActionResult(value: unknown, action: ControlAction, origin: string): ActionResult {
  if (!obj(value) || typeof value.duplicate !== 'boolean' || !obj(value.receipt) || !['recorded', 'incomplete', 'rejected', 'unconfirmed'].includes(String(value.receipt.state)) || !string(value.receipt.message) || (value.receipt.signed_out !== undefined && typeof value.receipt.signed_out !== 'boolean') || (value.receipt.navigation !== undefined && !string(value.receipt.navigation))) throw new ControlsActionError('receipt_unavailable', 'The action receipt is unavailable. Check this request before trying another change.', true);
  const receipt: ActionReceipt = { state: value.receipt.state as ActionReceipt['state'], message: value.receipt.message };
  if (value.receipt.signed_out !== undefined) {
    if (!action.startsWith('session.signout') || receipt.state !== 'recorded') throw new ControlsActionError('receipt_unavailable', 'The session receipt is unsupported. Sign in again to check the session.', true);
    receipt.signed_out = value.receipt.signed_out;
  }
  if (value.receipt.navigation !== undefined) {
    if ((action !== 'google.connect' && action !== 'mcp.connect') || receipt.state !== 'recorded') throw new ControlsActionError('receipt_unavailable', 'The navigation receipt is unsupported. Refresh the controls.', true);
    receipt.navigation = allowedControlNavigation(value.receipt.navigation, origin);
  }
  if (value.reveal === undefined) return { receipt, duplicate: value.duplicate };
  return { receipt, duplicate: value.duplicate, reveal: readReveal(value.reveal, action, receipt.state === 'recorded' && !value.duplicate) };
}

// Each one-time value has one action and one exact shape; anything else is refused, never shown.
const REVEALS: Partial<Record<ControlAction, { kind: ActionReveal['kind']; shape: RegExp }>> = {
  'imessage.link': { kind: 'link_code', shape: /^waldo [A-HJ-NP-Z2-9]{10}$/ }, 'imessage.enroll': { kind: 'link_code', shape: /^waldo [A-HJ-NP-Z2-9]{10}$/ },
  'imessage.pair': { kind: 'host_code', shape: /^wim_[a-f0-9]{48}$/ }, 'imessage.pair_shared': { kind: 'host_code', shape: /^wim_[a-f0-9]{48}$/ },
  'imessage.verify': { kind: 'challenge', shape: /^wic_[a-f0-9]{48}$/ },
  'device.pair': { kind: 'pairing_code', shape: /^wp1\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/ },
};
function readReveal(value: unknown, action: ControlAction, fresh: boolean): ActionReveal {
  const expected = REVEALS[action];
  const unsupported = () => new ControlsActionError('receipt_unavailable', 'The code in this receipt is unsupported. Refresh the controls before trying again.', true);
  if (!fresh || !expected || !obj(value) || value.kind !== expected.kind || !string(value.value) || !expected.shape.test(value.value)) throw unsupported();
  const to = expected.kind === 'link_code' && string(value.to) && /^(\+[1-9]\d{6,14}|[^\s@<>]{1,64}@[^\s@<>]{1,190})$/.test(value.to) ? value.to : undefined;
  return { kind: expected.kind, value: value.value, ...(to ? { to } : {}) };
}

export async function submitControl(data: Pick<ControlRecord,'csrf'|'revision'> & {view:ControlsView|'memory'}, action: ControlAction, fields: ControlFields, requestId: string, origin = globalThis.location?.origin ?? ''): Promise<ActionResult> {
  const body = new FormData();
  body.set('csrf', data.csrf); body.set('view', data.view); body.set('revision', data.revision); body.set('request_id', requestId); body.set('action', action);
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) body.set(key, value);
  let response: Response;
  try { response = await fetch('/console/dashboard/api/v1/actions', { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { accept: 'application/json' }, body }); }
  catch { throw new ControlsActionError('outcome_unavailable', 'The response was lost. Check this same request before making another change.', true); }
  if (response.status === 401) throw new SignInRequired();
  let value: unknown;
  try { value = await response.json(); } catch { throw new ControlsActionError('receipt_unavailable', 'The action receipt could not be read. Check this request before trying another change.', true); }
  if (isStepUpRefusal(response.status, value)) throw new StepUpRequired();
  if (obj(value) && obj(value.receipt)) {
    const result = readActionResult(value, action, origin);
    const coherent = response.ok && ['recorded', 'incomplete'].includes(result.receipt.state)
      || response.status === 409 && result.receipt.state === 'rejected'
      || response.status === 503 && result.receipt.state === 'unconfirmed';
    if (!coherent) throw new ControlsActionError('receipt_unavailable', 'The action response and receipt disagree. Check this request before making another change.', true);
    return result;
  }
  if (response.status === 409) {
    const code = obj(value) && string(value.error) && ['stale_read', 'no_longer_eligible', 'request_reused'].includes(value.error) ? value.error : 'not_completed';
    throw new ControlsActionError(code, 'These records or action eligibility changed. Refresh and review the controls before deciding again.');
  }
  if (response.status === 403) throw new ControlsActionError('invalid_action', 'The action was not accepted. Reload the controls to renew the session before trying again.');
  throw new ControlsActionError('outcome_unavailable', 'The outcome is unavailable. Check this request before making another change.', true);
}
