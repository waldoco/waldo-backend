import { ownerEffectOperationRef, type OwnerEffectLedger } from '../../channels/owner-effect-ledger';
import { taskSourceClient } from '../task-source-io';
import { availabilityWindows, ownerWindows } from './availability';
import type { ProxyIntent } from '../../connectors/proxy-intent';
import { artifactMarker, extractArtifacts, quarantineArtifacts, type ArtifactKind, type ExtractedArtifact } from '../../security/artifact-hygiene';
import {
  calendarPageSchema, queryAvailabilityArgsSchema, type QueryAvailabilityArgs,
  googleCalendarListPageSchema, googleTaskListPageSchema, googleTasksPageSchema, type GoogleTasksPage,
  connectServiceArgsSchema, draftEmailArgsSchema, getCommunicationArgsSchema, readThreadArgsSchema, searchCommunicationArgsSchema, searchContactsArgsSchema, contactMatchSchema, type ContactMatch, getTasksArgsSchema, proposeCalendarChangeArgsSchema, queryCalendarArgsSchema, sendEmailArgsSchema, TOOL_PERMISSIONS, triggerTypeSchema,
  type ConnectIntent, type ConnectServiceArgs, type DraftEmailArgs, type GetCommunicationArgs, type ReadThreadArgs, type SearchCommunicationArgs, type SearchContactsArgs, type GetTasksArgs, type ProposeCalendarChangeArgs, type QueryCalendarArgs, type SendEmailArgs, type ToolEligibility, type ToolHandler, type ToolName, type ToolResult,
} from '@waldo/contracts';
import { PEOPLE_UNREADABLE, b64url, buildMime, validMessageId, validFreeBusyCalendar, GoogleError, sha256Hex, type CalendarPage, type FreeBusyResult, type GoogleClient, type GoogleFeature, type ThreadMessage } from '../../connectors/google';
import { EmailProposalError, proposalStatus, type CardPlacement, type EmailSendProposal } from '../../channels/approvals';
import type { ToolDispatcherContext } from '../dispatcher';
import type { OwnerClock } from './get-context';
import { connectNeededText } from './connect-text';
import { carriesSecretOrCanary, sanitise } from '../../scribe/sanitiser';

export type GoogleAccess = Readonly<{
  client(feature?: GoogleFeature, intent?: ProxyIntent, assertTaskSourceCurrent?: () => Promise<void>, account?: string): Promise<GoogleClient | null>;
  state?():Promise<readonly Readonly<{id:string;email:string;error:string|null;calendar:boolean;mail:boolean;tasks:boolean}>[]>;
}>;

export type EffectDesk = Readonly<{
  propose(proposal: ProposeCalendarChangeArgs, turnKey?: string, operationRef?: string): Promise<string>;
  proposeSendEmail(proposal: EmailSendProposal): Promise<string>;
  record(kind: string, summary: string, payload: unknown): void;
  placement?(id: string): CardPlacement;
}>;

const allowlist = (name: ToolName) => triggerTypeSchema.options.filter((trigger) => TOOL_PERMISSIONS[trigger].includes(name));
const DAY_MS = 24 * 60 * 60_000;
const assertCollectionAccount = (observed: { connection_id: string | null; email: string | null }, client: GoogleClient) => {
  if ((observed.connection_id !== null && observed.connection_id !== client.account?.connection_id) || (observed.email !== null && observed.email.toLowerCase() !== client.account?.email?.toLowerCase())) throw new Error('Google collection account does not match the selected connection');
};

// S4 (CONNECT_FLOW_DESIGN 4.4): auth failures are a typed intent, never a URL in text. The
// responder sees `connect` and calls the channel's offerConnect seam; the model only ever
// reads this fixed sentence.
// source_taint 'external': these handlers are external-origin tools (ADR-0049) - the failure
// arm must carry the stamp or the dispatcher rejects the result outright.
const authFailed = (reason: ConnectIntent['reason'], feature: GoogleFeature): ToolResult<never> => ({
  ok: false, code: 'auth_failed', error: connectNeededText(reason, feature), source_taint: 'external',
  connect: { status: 'auth_required', service: 'google', reason, feature },
});

const UNREADABLE_ANSWER = "Nothing was read: the connector's answer was not in a form Waldo can read. What this read covers was not seen, so it is not known to be empty or free. The same read fails the same way until that is fixed.";
// Raised only where a connector answer is parsed, so a failing schema elsewhere (an approval card) is never told as a read.
class UnreadableAnswer extends Error {}
const connectorAnswer = <T>(schema: Readonly<{ safeParse(value: unknown): { success: true; data: T } | { success: false } }>, value: unknown): T => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new UnreadableAnswer('unreadable connector answer');
  return parsed.data;
};

async function withGoogle<T extends object>(google: GoogleAccess, feature: GoogleFeature, ctx: ToolDispatcherContext | undefined, work: (client: GoogleClient) => Promise<T>, account?: string): Promise<ToolResult<T>> {
  try {
  const client = await google.client(feature, undefined, ctx?.assertTaskSourceCurrent, account);
  if (client === null) return authFailed(await missingClientReason(google, feature, account), feature);
    if (account && client.account?.email?.toLowerCase() !== account.toLowerCase()) throw new Error('Selected Google account is unavailable; no other account was used');
    const data = await work(taskSourceClient(client, ctx));
    return { ok: true, data: { ...data, account: client.account ?? {connection_id:null,email:null} }, source_taint: 'external' };
  } catch (error) {
    // 401 = the stored grant is dead. A 403 prompts for consent only on structured evidence that the scope is
    // missing; a disabled API, a quota or a plain denial is not fixed by consent, so it returns the provider's words.
    if (error instanceof GoogleError && error.status === 403 && error.reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT') return authFailed('scope_missing', feature);
    if (error instanceof GoogleError && error.status === 403) return { ok: false, code: 'rejected', error: `Google refused the request (403${error.reason === 'SERVICE_DISABLED' ? ', the API is disabled for this project' : ''}): ${error.message}`, source_taint: 'external' };
    if (error instanceof GoogleError && error.status === 401) return authFailed('reauth_needed', feature);
    // An answer that fails its schema fails the same way on every retry until one side is redeployed, so it is refused.
    // The model hears fixed words: the parse error names fields, never what the owner needs to hear.
    if (error instanceof UnreadableAnswer) return { ok: false, code: 'rejected', error: UNREADABLE_ANSWER, source_taint: 'external' };
    if (error instanceof BodyWithheld) return { ok: false, code: 'rejected', error: 'This message body could not be checked safely, so it is withheld.', source_taint: 'external' };
    return { ok: false, code: 'transient', error: error instanceof Error ? error.message : String(error), source_taint: 'external' };
  }
}

type KnownAccount = Awaited<ReturnType<NonNullable<GoogleAccess['state']>>>[number];
const flagged = (feature: GoogleFeature): feature is 'calendar' | 'mail' | 'tasks' => feature === 'calendar' || feature === 'mail' || feature === 'tasks';

// Why no client serves a read. A connected account whose grant is failing (invalid_grant recorded, circuit open) needs a
// reconnect. A connected, healthy account that still gets no client has a grant without the feature: state() reports
// calendar, mail and tasks, and for the other features nothing else keeps a healthy grant from serving. Otherwise the
// account is not connected.
export const missingClientReason = async (google: GoogleAccess, feature: GoogleFeature, account?: string): Promise<ConnectIntent['reason']> => {
  const known = (google.state ? await google.state() : []).filter((candidate) => !account || candidate.email.toLowerCase() === account.toLowerCase());
  if (known.some((candidate) => candidate.error !== null && (!flagged(feature) || candidate[feature]))) return 'reauth_needed';
  if (known.length && known.every((candidate) => flagged(feature) ? !candidate[feature] : candidate.error === null)) return 'scope_missing';
  return 'not_connected';
};

// The accounts a read covers when none is named: every connected one whose grant holds the feature. state() reports only
// calendar, mail and tasks, so for the other features every account counts and a missing grant is named by its read.
export const accountsToRead = async (google: GoogleAccess, feature: GoogleFeature, named?: string): Promise<readonly KnownAccount[]> =>
  !named && google.state ? (await google.state()).filter((known) => !flagged(feature) || known[feature]) : [];

// An id from one account's result (a continuation, a list, a thread, a calendar) means nothing in another account.
export const nameTheAccount = (accounts: readonly KnownAccount[], what: string): ToolResult<never> => ({
  ok: false, code: 'rejected', source_taint: 'external',
  error: `${what} belongs to one Google account, and ${accounts.length} are connected: ${accounts.map((known) => known.email).join(', ')}. Pass account with the one it came from.`,
});

// Each account reads its share of the tool's page bound, so the combined result stays inside what one page may hold.
export const accountShare = (limit: number, max: number, accounts: number): number => Math.min(limit, Math.max(1, Math.floor(max / accounts)));

const FEATURE_NAMES: Readonly<Record<GoogleFeature, string>> = {
  calendar: 'Google Calendar', availability: 'Google Calendar', calendar_list: 'Google Calendar', mail: 'Gmail', tasks: 'Google Tasks',
  contacts: 'Google Contacts', drive: 'Google Drive', docs: 'Google Docs', sheets: 'Google Sheets', slides: 'Google Slides',
};
type Failed = Extract<ToolResult<unknown>, { ok: false }>;
const accountFix = (email: string, feature: GoogleFeature, failed: Failed): string | undefined =>
  failed.connect?.reason === 'scope_missing' ? `Reconnect ${email} and allow ${FEATURE_NAMES[feature]} when Google asks.`
    : failed.connect?.reason === 'reauth_needed' ? `Reconnect ${email}: Google no longer accepts its sign-in.`
      : failed.connect ? `Connect ${email} again.`
        : failed.code === 'transient' ? 'Try this account again.' : undefined;
const NOT_READ = 'An account that was not read is unknown, not empty.';
const ACCOUNT_ERROR_CHARS = 300;

// Every account is read at once. Each result keeps its own account receipt, and an account that fails is named with its
// reason and fix while the others still come back. The per-account summary comes first, so it stays in view when a long
// result is shown only in part.
export const readEveryAccount = async <T>(tool: ToolName, feature: GoogleFeature, accounts: readonly KnownAccount[], read: (email: string) => Promise<ToolResult<T>>): Promise<ToolResult<Readonly<{ accounts: readonly unknown[]; note: string; by_account: readonly T[] }>>> => {
  const results = await Promise.all(accounts.map((known) => read(known.email)));
  const summary = accounts.map((known, index) => {
    const result = results[index]!;
    if (result.ok) return { email: known.email, read: 'ok' as const };
    const fix = accountFix(known.email, feature, result);
    return { email: known.email, read: 'failed' as const, code: result.code, ...(result.connect ? { reason: result.connect.reason } : {}), error: result.error.slice(0, ACCOUNT_ERROR_CHARS), ...(fix ? { fix } : {}) };
  });
  const failed = results.filter((result): result is Failed => !result.ok);
  // Content-free: how many accounts were read and how each failure failed, never an address.
  console.log(JSON.stringify({ hop: 'google_read_accounts', ok: failed.length === 0, code: `${tool}:read_${results.length - failed.length}_of_${results.length}${failed.map((result) => `:${result.code}${result.connect ? `_${result.connect.reason}` : ''}`).join('')}`.slice(0, 64) }));
  if (failed.length === results.length) {
    const auth = failed.every((result) => result.connect);
    return {
      ok: false, code: auth ? 'auth_failed' : failed.some((result) => result.code === 'transient') ? 'transient' : 'rejected', source_taint: 'external',
      error: [`No connected Google account could be read. ${NOT_READ}`, ...summary.map((entry) => `${entry.email}: ${'error' in entry ? entry.error : ''}${'fix' in entry && entry.fix ? ` Fix: ${entry.fix}` : ''}`)].join('\n'),
      ...(auth ? { connect: failed[0]!.connect! } : {}),
    };
  }
  return { ok: true, source_taint: 'external', data: {
    accounts: summary,
    note: `Every connected Google account was read at once: accounts says how each went, by_account holds each account's result under its account.${failed.length ? ` ${NOT_READ}` : ''} To continue one account, pass that account with its own page token and page_limit.`,
    by_account: results.flatMap((result) => result.ok ? [result.data] : []),
  } };
};

// A read without a named account covers every connected account. bound names an id in the call that belongs to one account;
// with more than one account connected, that id must come with its account.
const readAccounts = async <T extends object>(google: GoogleAccess, tool: ToolName, feature: GoogleFeature, ctx: ToolDispatcherContext | undefined, args: Readonly<{ account?: string | undefined; limit: number }>, max: number, bound: string | null, work: (client: GoogleClient, limit: number) => Promise<T>): Promise<ToolResult<unknown>> => {
  const accounts = await accountsToRead(google, feature, args.account);
  if (accounts.length < 2) return withGoogle(google, feature, ctx, (client) => work(client, args.limit), args.account);
  if (bound) return nameTheAccount(accounts, bound);
  const limit = accountShare(args.limit, max, accounts.length);
  return readEveryAccount(tool, feature, accounts, (email) => withGoogle(google, feature, ctx, (client) => work(client, limit), email));
};

// Eligibility reads granted scopes, never the recorded error: a failing grant keeps its tools so the call asks for a
// reconnect. One in-flight state read serves every handler's check in a turn and is dropped when it settles.
const pendingState = new WeakMap<GoogleAccess, ReturnType<NonNullable<GoogleAccess['state']>>>();
const granted = (google: GoogleAccess, feature: 'calendar' | 'mail' | 'tasks') => async (): Promise<ToolEligibility> => {
  if (!google.state) return { ok: true };
  let read = pendingState.get(google);
  if (!read) { read = google.state().finally(() => pendingState.delete(google)); pendingState.set(google, read); }
  const accounts = await read;
  return accounts.some((account) => account[feature]) ? { ok: true }
    : { ok: false, reason: 'not_connected', connect: { status: 'auth_required', service: 'google', reason: accounts.length ? 'scope_missing' : 'not_connected', feature } };
};

// Reply intent is resolved from the selected account, never from model-supplied RFC headers.
const replyHeaders = async (client: GoogleClient, args: DraftEmailArgs) => {
  if (!args.reply_to_thread_id) {
    if (args.in_reply_to_msg_id) throw new Error('A reply parent requires its Gmail thread.');
    return {};
  }
  if (!client.threadPage) throw new Error('Gmail reply metadata is unavailable.');
  let cursor: string | undefined;
  let parent: Awaited<ReturnType<NonNullable<GoogleClient['threadPage']>>>['messages'][number] | undefined;
  for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
    const page = await client.threadPage(args.reply_to_thread_id, 20, cursor);
    if (args.in_reply_to_msg_id) parent ??= page.messages.find(m => m.id === args.in_reply_to_msg_id);
    else parent = page.messages.at(-1) ?? parent;
    if ((parent && args.in_reply_to_msg_id) || !page.cursor) break;
    if (pageNumber === 9) throw new Error('Reply thread exceeds the metadata review budget; select a parent message.');
    cursor = page.cursor;
  }
  if (!parent || !validMessageId(parent.message_id)) throw new Error('Reply parent has no valid provider Message-ID in this thread.');
  const subject = (value: string) => value.replace(/^(?:\s*re:\s*)+/i, '').trim();
  if (/[\r\n]/.test(args.subject) || subject(args.subject) !== subject(parent.subject)) throw new Error('Reply subject differs from its parent thread.');
  if (parent.references && (parent.references.length > 100 || !parent.references.every(validMessageId))) throw new Error('Reply parent References are invalid.');
  return { inReplyTo: parent.message_id, references: [...new Set([...(parent.references ?? []), parent.message_id])] };
};

// E1 (issue #150) as amended by the owner's September 27, 2026 ruling ("instinct way for OTP"):
// a verification artifact in either visible list field quarantines both - the snippet routinely
// re-states a code the subject hides, and vice versa. The list marker tells the model the honest
// path: read the thread and the artifact is relayed to the owner directly (see read_thread).
// from/at/id stay so the owner can find the item in Gmail itself; the raw artifact never enters
// model context.
const quarantineMailItem = <T extends { subject: string; snippet: string }>(item: T): T & { quarantined?: readonly ArtifactKind[] } => {
  const q = quarantineArtifacts(`${item.subject}
${item.snippet}`);
  if (q.kinds.length === 0) return item;
  const marker = `[quarantined: ${q.kinds.join('/')} artifact - read the thread; it is relayed to the owner directly]`;
  return { ...item, subject: marker, snippet: marker, quarantined: q.kinds };
};

// The relay sink: the owner DO wires this to a direct Telegram/WhatsApp send. Returns false when
// the send failed so the marker can fall back to the honest source-app copy instead of claiming a
// relay that never happened. Absent in probes/tests: the marker falls back the same way.
export type ArtifactRelay = (from: string, artifacts: readonly ExtractedArtifact[]) => Promise<boolean>;

// E1 for thread bodies, post-ruling: the artifact is EXTRACTED from the full body (complete text,
// never a truncated snippet) and relayed to the owner on his chat channel - the Instinct behavior
// without the code ever entering model context, episodes, or traces. The tool result carries only
// the marker; a failed or absent relay falls back to the source-app copy, never a false claim.
// Thread bodies reach the model in chunks. Each read prepares the whole body the same way before cutting
// it, and offsets count the prepared text, so no code, link or health reading is split across chunks and
// every read of a message lines up:
// - unbroken runs longer than RUN_MAX are omitted, because extraction backtracks across a run and its
//   cost grows with the square of the run's length (11 seconds for a hostile 200,000-character run);
// - verification artifacts are extracted;
// - when the connector cut the body at its bound, the cut word and the text just before it are dropped,
//   since the cut can fall inside a code or link that then matches no pattern;
// - the scribe withholds health readings over the whole body, because it sees one tool result at a time.
// A chunk fits one tool result without offloading, and one read's bodies fit the tool-output store, so no
// message is cut silently; the rest of each body is read by offset.
const BODY_CHUNK = 12_000;
const READ_BODY_BUDGET = 40_000;
const RUN_MAX = 2_048;
const CUT_GUARD = 256;
const omitLongRuns = (text: string): string => text.replace(/[^\s"'<>)\]]+/g, (run) => run.length > RUN_MAX ? `[${run.length} characters of unbroken text omitted]` : run);
const dropCutTail = (text: string): string => {
  let end = text.length;
  while (end > 0 && !/\s/.test(text[end - 1]!)) end--;
  return text.slice(0, Math.max(0, end - CUT_GUARD));
};
// A body the scribe will not pass (health markers can grow a dense one past its size limit) is withheld whole. Retrying
// reads the same body, so it is never reported as transient.
class BodyWithheld extends Error {}
const WITHHELD_BODY = "[This message's body was withheld: it could not be checked safely, so it is not shown.]";
const scribedBody = (text: string, canaries: readonly string[]): string => {
  const scribed = sanitise({ payload: { body: text }, destination: 'internal_context', source_taint: 'external', canary_tokens: [...canaries] });
  if (!scribed.ok) {
    // Which check refused it and why, nothing of the message: a canary, a secret and a health refusal stay distinguishable in traces.
    console.log(JSON.stringify({ hop: 'mail_body_withheld', ok: false, code: `${scribed.check}:${scribed.reason}` }));
    throw new BodyWithheld('mail body refused by the scribe');
  }
  return (scribed.payload as { body: string }).body;
};
const freshCanaries = () => Array.from({ length: 3 }, () => crypto.randomUUID().replaceAll('-', '').slice(0, 16));
type BodyRead = Readonly<{ relay?: ArtifactRelay; offset: number; first: boolean; canaries: readonly string[] }>;
// A connector-proxy older than the messageId read ignores it and returns the thread's first message, so the
// message is then found by paging the thread, within the reply-parent lookup's budget of 10 pages.
const messageById = async (client: GoogleClient, threadId: string, messageId: string): Promise<ThreadMessage> => {
  const direct = await client.threadPage!(threadId, 1, undefined, { fullBodies: true, bodyChunks: true, messageId });
  if (direct.messages.length === 1 && direct.messages[0]!.id === messageId) return direct.messages[0]!;
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
    const page = await client.threadPage!(threadId, 20, cursor, { fullBodies: true, bodyChunks: true });
    const found = page.messages.find(message => message.id === messageId);
    if (found) return found;
    if (!page.cursor) break;
    cursor = page.cursor;
  }
  throw new Error('unknown message in thread');
};

// The connector lists a message's link targets after its body. A target the scribe would refuse (a token or key in a hidden
// href) is left out of that list, so it cannot make the scribe refuse the whole thread. The connector is also bundled into the
// connector-proxy edge function, which cannot import the scribe, so this runs where the result is built.
const LINK_LIST_HEADER = '\n\nLinks:\n';
export const withoutFlaggedLinks = (body: string): string => {
  const at = body.lastIndexOf(LINK_LIST_HEADER);
  if (at < 0) return body;
  const kept = body.slice(at + LINK_LIST_HEADER.length).split('\n').filter((line) => !carriesSecretOrCanary(line));
  return kept.length ? `${body.slice(0, at)}${LINK_LIST_HEADER}${kept.join('\n')}` : body.slice(0, at);
};

const readMessages = async (messages: readonly ThreadMessage[], read: BodyRead) => {
  let budget = read.first ? READ_BODY_BUDGET : BODY_CHUNK;
  const shownMessages = [];
  for (const item of messages) {
    const { artifact_scan: scan, body_full_chars: clipped, attachments: listed, ...visible } = item;
    const subject = extractArtifacts(omitLongRuns(visible.subject));
    const body = extractArtifacts(omitLongRuns(withoutFlaggedLinks(visible.body)));
    const names = (listed ?? []).map((attachment) => ({ attachment, name: extractArtifacts(attachment.filename) }));
    const shown = [...subject.artifacts, ...body.artifacts, ...names.flatMap(({ name }) => name.artifacts)].filter((artifact, index, all) => all.findIndex((other) => other.value === artifact.value) === index);
    const linked = extractArtifacts(omitLongRuns(scan ?? '')).artifacts.filter((artifact) => !shown.some((other) => other.value === artifact.value));
    const artifacts = [...shown, ...linked];
    // An artifact found only in an HTML link target has no span to replace, so its marker is appended.
    // On the first read of a thread one such message does not hide the others. A continuation asks for that message alone.
    let safe: string, withheld = false;
    try { safe = scribedBody(clipped === undefined ? body.text : dropCutTail(body.text), read.canaries); } catch (error) {
      if (!(error instanceof BodyWithheld) || !read.first) throw error;
      safe = WITHHELD_BODY; withheld = true;
    }
    const prepared = [safe, ...new Set(linked.map((artifact) => artifactMarker(artifact.kind)))].join('\n');
    if (!Number.isSafeInteger(read.offset) || read.offset < 0 || (read.offset > 0 && read.offset >= prepared.length)) throw new Error('invalid body offset');
    const end = read.offset + Math.min(BODY_CHUNK, budget);
    const chunk = prepared.slice(read.offset, end);
    budget -= chunk.length;
    // The position comes before the body, so it stays in view when a long result is shown only in part.
    const position = { ...(end < prepared.length ? { body_total_chars: prepared.length, body_next_offset: end } : {}), ...(clipped !== undefined ? { body_truncated: true as const } : {}), ...(withheld ? { body_withheld: 'scribe_refused' as const } : {}) };
    const files = read.first && listed ? { attachments: names.map(({ attachment, name }) => ({ ...attachment, filename: name.text })) } : {};
    if (artifacts.length === 0) { shownMessages.push({ ...position, ...visible, ...files, subject: subject.text, body: chunk }); continue; }
    const kinds = [...new Set(artifacts.map((artifact) => artifact.kind))].sort();
    const relayed = read.relay !== undefined && await read.relay(item.from, artifacts).then((sent) => sent === true, () => false);
    // Only the matched spans are replaced; the rest stays readable. A failed or absent relay (a later read
    // never relays again) keeps the source-app marker, never a false sent claim.
    const present = (text: string): string => relayed ? kinds.reduce((t, kind) => t.replaceAll(artifactMarker(kind), `[${kind} artifact - sent to the owner in a separate message]`), text) : text;
    shownMessages.push({ ...position, ...visible, ...files, subject: present(subject.text), body: present(chunk), quarantined: kinds });
  }
  return shownMessages;
};

// One content-free line per failed calendar read: which operation and how it failed, never the provider's words.
const loggedCalendarRead = <T>(operation: QueryCalendarArgs['operation'], result: ToolResult<T>): ToolResult<T> => {
  if (!result.ok) console.log(JSON.stringify({ hop: 'calendar_read', ok: false, code: `op_${operation === 'list_calendars' ? 'calendars' : 'events'}:${result.error === UNREADABLE_ANSWER ? 'unreadable_answer' : result.code}${result.connect ? `:${result.connect.reason}` : ''}` }));
  return result;
};

export const googleHandlers = (google: GoogleAccess, desk: EffectDesk, clock: OwnerClock, relayArtifact?: ArtifactRelay, effects?: OwnerEffectLedger) => [
  {
    name: 'query_calendar',
    description: "Read a bounded page of events, now through the next 24 hours by default. list_calendars lists each account's other calendars (id, name, access role, time zone; visible unless include_hidden); read one with its calendar_id and account. Continue next_page_token with that account and the same date_range, calendar_id, limit and include_declined. Each result holds only its current page, not a complete window. Legacy adapters report unknown account and incomplete coverage. Event enumeration, not availability.",
    schema: queryCalendarArgsSchema,
    trigger_allowlist: allowlist('query_calendar'),
    autonomy_gated: false,
    requires_connector: true,
    eligible: granted(google, 'calendar'),
    handle: async ({ date_range, include_declined, limit, calendar_id = 'primary', page_token, account, operation, include_hidden = false }: QueryCalendarArgs, ctx?: ToolDispatcherContext) => loggedCalendarRead(operation, await readAccounts(google, 'query_calendar', operation === 'list_calendars' ? 'calendar_list' : 'calendar', ctx, { account, limit }, 50,
      page_token ? 'A page_token' : operation !== 'list_calendars' && calendar_id !== 'primary' ? 'A calendar_id other than primary' : null, async (client, limit) => {
      if (operation === 'list_calendars') {
        if (!client.calendarListsPage) throw new Error('Calendar discovery adapter unavailable');
        const page = connectorAnswer(googleCalendarListPageSchema, await client.calendarListsPage(limit, include_hidden, page_token));
        if (page.fetched_count > limit) throw new Error('Calendar-list page exceeds requested limit');
        assertCollectionAccount(page.account, client);
        return { calendars: page.items, observed_at: page.observed_at, next_page_token: page.next_page_token, coverage: { scope: 'account_calendars', result_scope: 'current_page', include_hidden, page_limit: limit, fetched_count: page.fetched_count, returned_count: page.items.length, page_exhausted: page.next_page_token === null, complete: !page_token && page.next_page_token === null } };
      }
      const now = clock.now().getTime();
      const from = date_range?.from ?? new Date(now).toISOString();
      const to = date_range?.to ?? new Date(now + DAY_MS).toISOString();
      let page: CalendarPage | null = null;
      if (typeof client.calendarPage === 'function') {
        try { page = connectorAnswer(calendarPageSchema, await client.calendarPage(calendar_id, from, to, limit, include_declined, page_token));
          if (page.fetched_count > limit) throw new Error('Calendar page exceeds requested limit'); }
        catch (error) {
          if (!(error instanceof GoogleError && error.status === 404 && error.message === 'unknown operation') || page_token || calendar_id !== 'primary') throw error;
        }
      }
      if (!page && (page_token || calendar_id !== 'primary')) throw new Error('Calendar pagination or selected calendar adapter unavailable');
      // The operation marker is for the desk's reconciliation of its own writes, not for the model.
      const events = (page?.events ?? await client.events(from,to,limit,include_declined)).map(({ operation_marker: _marker, ...event }) => event);
      // One content-free line per calendar read: which window and which kind of calendar were asked for, and how many
      // events came back. Never the calendar id or the account, either of which can be an address. The primary calendar's
      // id is the account address, so a read by that id counts as primary. The code stays within [a-z0-9_:]{1,64}, so a
      // log viewer that whitelists hop codes by that charset keeps it.
      const primary = calendar_id === 'primary' || calendar_id.toLowerCase() === client.account?.email?.toLowerCase();
      console.log(JSON.stringify({ hop: 'calendar_read', ok: true, code: `window_${date_range ? 'date_range' : 'default'}:calendar_${primary ? 'primary' : 'other'}:page_${page_token ? 'next' : 'first'}`, count: events.length }));
      return {
        timezone: clock.timezone, from, to, events,
        observed_at: page?.observed_at ?? clock.now().toISOString(), next_page_token: page?.next_page_token ?? null,
        coverage: {
          account: page?.account ?? {connection_id:null,email:null}, calendar_id, window:{from,to}, include_declined, page_limit:limit,
          fetched_count:page?.fetched_count ?? null, returned_count:events.length,
          pagination:page?'provider_page':'unknown_not_returned_by_adapter', page_exhausted:page? page.next_page_token === null : null,
          complete: Boolean(page && !page_token && page.next_page_token === null), result_scope:'current_page',
          limitation:page?'One account and calendar. Each result contains only its current page. A local null connection_id means host canonical mapping is unavailable; email is grant metadata, not permission.':'Legacy sampled primary-calendar read; account and pagination are unknown. Empty does not prove absence.',
        },
      };
    })),
  } satisfies ToolHandler<QueryCalendarArgs, unknown, ToolDispatcherContext>,
  {
    name: 'get_communication',
    description: "Read a sampled page from the Gmail Primary inbox category, not the entire inbox. Defaults to a rolling 24-hour window, not today. A page with complete false and a next_page_token is a normal answer, not a failure: read it, summarise it, and say it is a sample. A message whose from differs from its account.email was sent by someone else, even when it is about the owner's own tasks. Pass that account and the same date_range with its page_token only when the owner needs older mail. Legacy adapters lack pagination; an empty legacy page does not prove no mail in the requested range.",
    schema: getCommunicationArgsSchema,
    trigger_allowlist: allowlist('get_communication'),
    autonomy_gated: false,
    requires_connector: true,
    eligible: granted(google, 'mail'),
    handle: ({ date_range,limit=10,page_token, account }: GetCommunicationArgs, ctx?: ToolDispatcherContext) => readAccounts(google, 'get_communication', 'mail', ctx, { account, limit }, 30, page_token ? 'A page_token' : null, async (client, limit) => {
      const since = date_range?.from ? Date.parse(date_range.from) : clock.now().getTime() - DAY_MS;
      const to = date_range?.to ?? clock.now().toISOString();
      const from = new Date(since).toISOString();
      const query=`in:inbox category:primary after:${Math.floor(since/1000)-1} before:${Math.ceil(Date.parse(to)/1000)}`;
      let paged=typeof client.mailPage==='function';
      let degraded=false;
      if(page_token&&!paged)throw new Error('Gmail pagination adapter unavailable');
      let page=null as Awaited<ReturnType<NonNullable<typeof client.mailPage>>>|null;
      if(paged){
        try{page=await client.mailPage(query,limit,page_token);}
        catch(error){
          // A connector proxy deployed before mailPage existed answers 404 'unknown operation'.
          // Degrade to the legacy sampled read (reported as unpaged) instead of failing the turn.
          if(!(error instanceof GoogleError&&error.status===404&&error.message==='unknown operation')||page_token)throw error;
          paged=false;
          degraded=true;
        }
      }
      const fetched=page? page.messages : await client.newMail(since,limit);
      const messages = fetched.filter(item => { const at = Date.parse(item.at); return Number.isFinite(at) && at >= since && at < Date.parse(to); }).map(quarantineMailItem);
      return { since: from, from: date_range?.from ?? from, to, timezone: clock.timezone, messages, account: client.account ?? {connection_id:null,email:null}, query: degraded?null:query, ...(degraded?{query_note:'legacy_since_filter_no_gmail_query'}:{}), next_page_token:page?.next_page_token??null,result_size_estimate:page?.result_size_estimate??null, coverage: {
        lower_bound_query: paged?'previous_epoch_second_then_exact_timestamp_filter':'legacy_adapter_lower_bound_unverified',
        cursor_query_binding: page_token?'caller_supplied_window_not_authenticated_to_cursor':'first_page',
        scope: 'inbox_primary_category', account_selection: 'connected_adapter_account_not_all_accounts',
        retrieval_window: date_range ? 'explicit_date_range' : 'rolling_24_hours', page_limit: limit,
        ...(degraded?{degraded:'proxy_without_mailPage'}:{}), fetched_count: fetched.length, returned_count: messages.length, pagination: paged?'provider_page':'unknown_not_returned_by_adapter',
        upper_bound_applied_after_page: !paged, complete: paged&&page!.next_page_token===null&&page_token===undefined&&fetched.length===messages.length,
        limitation: paged?'Primary inbox category from one adapter account. Provider cursor is opaque and not authenticated to this supplied query/window. Result size is an estimate. Not all accounts or categories.':'One sampled Primary-inbox page; pagination is unavailable. A newer page may exclude messages in an older requested window. Empty results do not prove the range is empty.',
      } };
    }),
  } satisfies ToolHandler<GetCommunicationArgs, unknown, ToolDispatcherContext>,
  {
    name: 'search_communication',
    description: "Search the owner's Gmail by sender, subject or words, optionally in a date range. Returns matching messages with from, subject, snippet, time and thread_id. Space-separated Gmail terms must all match; do not paste a full natural-language ask as the query. Start with distinctive sender/repository/topic terms. An empty match is not absence: try a narrower-term query while preserving the same account, date range and result limit, then report the search limit. Never rewrite a quoted or operator query silently. Use get_communication for 'what is new' instead, and read_thread to read one thread in full. Continue search pages with cursor and the same query/date range/account.",
    schema: searchCommunicationArgsSchema,
    trigger_allowlist: allowlist('search_communication'),
    autonomy_gated: false,
    requires_connector: true,
    eligible: granted(google, 'mail'),
    handle: ({ query, date_range, limit, cursor, account }: SearchCommunicationArgs, ctx?: ToolDispatcherContext) => readAccounts(google, 'search_communication', 'mail', ctx, { account, limit }, 20, cursor ? 'A cursor' : null, async (client, limit) => {
      const clauses = [query];
      if (date_range?.from) clauses.push(`after:${Math.floor(Date.parse(date_range.from) / 1000)}`);
      if (date_range?.to) clauses.push(`before:${Math.floor(Date.parse(date_range.to) / 1000)}`);
      const page = await client.mailPage(clauses.join(' '), limit, cursor);
      const messages = page.messages.map(quarantineMailItem);
      return { query, messages, account: client.account ?? {connection_id:null,email:null}, cursor: page.next_page_token, coverage: { scope: 'matching_query_one_adapter_account', complete: false, limitation: 'Bounded matching search, not a complete view of Gmail or all accounts.' },
        ...(messages.length === 0 ? { recovery: {
          status: 'empty_query_not_absence', preserve_date_range: true,
          query_semantics: 'unquoted_terms_are_conjunctive',
          next_step: 'Use fewer distinctive terms or a known sender/repository only when this preserves the request. Keep the same account, date range and result limit. Preserve explicit exact phrases, sender restrictions and operators; do not drop them to find unrelated mail. Read returned subjects/snippets to check relevance. Empty still means no matches for this query, not no mail.',
        } } : {}),
      };
    }),
  } satisfies ToolHandler<SearchCommunicationArgs, unknown, ToolDispatcherContext>,
  {
    name: 'search_contacts',
    description: "Find people in the owner's Google contacts and among the people they have emailed, by the start of a name or an address. Use it to work out who the owner means before drafting, sending or inviting. If more than one person could be meant, or the match is uncertain, ask the owner which person rather than guessing a recipient. An empty result does not mean the person is unknown: the owner may never have saved or emailed them.",
    schema: searchContactsArgsSchema,
    trigger_allowlist: allowlist('search_contacts'),
    autonomy_gated: false,
    requires_connector: true,
    handle: ({ query, limit, account }: SearchContactsArgs, ctx?: ToolDispatcherContext) => readAccounts(google, 'search_contacts', 'contacts', ctx, { account, limit }, 10, null, async (client, limit) => {
      if (!client.searchContacts) throw new Error('Google contacts adapter unavailable');
      // Only the contract's fields are picked, so a phone, organisation or photo can never ride along. The contract's
      // address check runs before an address is kept or counted: a refused address never takes one of a person's three
      // places, and never hides an address another person shares.
      const seen = new Set<string>();
      const contacts: ContactMatch[] = [];
      const rows = await client.searchContacts(query, limit).catch((error: unknown) => {
        // A malformed People answer fails the same way on every retry, so it is refused like any unreadable answer.
        throw error instanceof Error && error.message === PEOPLE_UNREADABLE ? new UnreadableAnswer('unreadable connector answer') : error;
      });
      for (const { name, emails, source } of rows) {
        const kept = emails.filter((email) => !seen.has(email) && contactMatchSchema.shape.emails.element.safeParse(email).success).slice(0, 3);
        const match = contactMatchSchema.safeParse({ name, emails: kept, source });
        if (!match.success) continue;
        kept.forEach((email) => seen.add(email));
        contacts.push(match.data);
        if (contacts.length === limit) break;
      }
      return { query, contacts, coverage: {
        matching: 'name_or_address_prefix', sources: ['contacts', 'other_contacts'],
        limitation: 'Names and addresses only, from one account. Empty means no saved or emailed person starts with this text, not that the person does not exist.',
      } };
    }),
  } satisfies ToolHandler<SearchContactsArgs, unknown, ToolDispatcherContext>,
  {
    name: 'read_thread',
    description: "Read one Gmail thread by thread_id - the messages with sender, recipients (to, cc, reply_to as plain addresses), subject, time and body. account.email is the owner's own address; send-as aliases are not marked. recipients_capped: a list was cut at 50 addresses, so reply-all would miss people: tell the owner. To reply to all, take the recipients from the message being replied to. Use after get_communication or search_communication lists the thread, with its account, before drafting a reply. Continue with cursor and the same thread/account; changed threads require restarting. body_next_offset means more body follows (body_total_chars in all): read it with body_message_id (the message's id) and body_offset set to body_next_offset, without a cursor. body_truncated: the message is longer than Waldo reads, so say the end is missing. attachments: name, type and size only, never read. body_source 'snippet': only Gmail's preview was readable; say so. body_withheld: not safe to show; tell the owner to open it in Gmail.",
    schema: readThreadArgsSchema,
    trigger_allowlist: allowlist('read_thread'),
    autonomy_gated: false,
    requires_connector: true,
    eligible: granted(google, 'mail'),
    handle: ({ thread_id, limit, cursor, account, body_message_id, body_offset }: ReadThreadArgs, ctx?: ToolDispatcherContext) => readAccounts(google, 'read_thread', 'mail', ctx, { account, limit }, 20, 'A thread_id', async (client, limit) => {
      if (!client.threadPage) throw new Error('Gmail thread pagination adapter unavailable');
      const canaries = ctx?.session?.canary_tokens ?? freshCanaries();
      if (body_message_id !== undefined) {
        const message = await messageById(client, thread_id, body_message_id);
        return {thread_id, account: client.account ?? {connection_id:null,email:null}, cursor: null, messages: await readMessages([message], { offset: body_offset ?? 0, first: false, canaries })};
      }
      const page = await client.threadPage(thread_id, limit, cursor, { fullBodies: true, bodyChunks: true });
      return {thread_id, account: client.account ?? {connection_id:null,email:null}, cursor: page.cursor, messages: await readMessages(page.messages, { relay: relayArtifact, offset: 0, first: true, canaries })};
    }),
  } satisfies ToolHandler<ReadThreadArgs, unknown, ToolDispatcherContext>,
  {
    name: 'get_tasks',
    description: "Read a bounded page of the owner's Google Tasks across all authorized lists by default, preserving each task_list_id. Use operation list_task_lists to discover list names, or task_list_id with its account to select one list. Continue next_page_token with that account and the same status/limit (coverage.page_limit)/operation/list. Inspect coverage: a continuation contains only its current page. Defaults to open tasks; completed/all reads include hidden completed tasks and assigned tasks. Google Tasks has no in-progress state; that filter returns open tasks with a note. Legacy adapters provide only a sampled default list with incomplete coverage.",
    schema: getTasksArgsSchema,
    trigger_allowlist: allowlist('get_tasks'),
    autonomy_gated: false,
    requires_connector: true,
    eligible: granted(google, 'tasks'),
    handle: ({ status, limit, account, operation, task_list_id, page_token }: GetTasksArgs, ctx?: ToolDispatcherContext) => readAccounts(google, 'get_tasks', 'tasks', ctx, { account, limit }, 100, page_token ? 'A page_token' : task_list_id ? 'A task_list_id' : null, async (client, limit) => {
      if (operation === 'list_task_lists') {
        if (!client.taskListsPage) throw new Error('Task-list discovery adapter unavailable');
        const page = connectorAnswer(googleTaskListPageSchema, await client.taskListsPage(limit, page_token));
        if (page.fetched_count > limit) throw new Error('Task-list page exceeds requested limit');
        assertCollectionAccount(page.account, client);
        return { task_lists: page.items, observed_at: page.observed_at, next_page_token: page.next_page_token, coverage: { scope: 'account_task_lists', result_scope: 'current_page', page_limit: limit, fetched_count: page.fetched_count, returned_count: page.items.length, page_exhausted: page.next_page_token === null, complete: !page_token && page.next_page_token === null } };
      }
      const method = task_list_id ? client.tasksPage : client.allTasksPage;
      let page: GoogleTasksPage | null = null;
      if (method) {
        try { page = connectorAnswer(googleTasksPageSchema, await (task_list_id ? client.tasksPage!(task_list_id, status, limit, page_token) : client.allTasksPage!(status, limit, page_token))); }
        catch (error) {
          if (!(error instanceof GoogleError && error.status === 404 && error.message === 'unknown operation') || page_token || task_list_id && task_list_id !== '@default') throw error;
        }
      }
      if (!page && (page_token || task_list_id && task_list_id !== '@default')) throw new Error('Tasks pagination or selected-list adapter unavailable');
      if (page) {
        if (page.tasks.length > limit || task_list_id && page.task_list_ids.some(id => id !== task_list_id)) throw new Error('Tasks page does not match selected list or limit');
        assertCollectionAccount(page.account, client);
      }
      const tasks = page?.tasks ?? await client.tasks(status, limit);
      return { status, tasks, next_page_token: page?.next_page_token ?? null, observed_at: page?.observed_at ?? clock.now().toISOString(),
        coverage: { scope: page ? task_list_id ? 'selected_task_list' : 'all_task_lists' : 'legacy_default_list_sample', task_list_ids: page?.task_list_ids ?? ['@default'], result_scope: 'current_page', page_limit: limit, fetched_count: page?.fetched_count ?? null, returned_count: tasks.length, page_exhausted: page ? page.next_page_token === null : null, complete: Boolean(page && !page_token && page.next_page_token === null), limitation: page ? 'One account. Each result contains its current page only; continue to cover further tasks/lists. Task due dates are provider date semantics, not scheduled times.' : 'Legacy default-list sample with unknown pagination; empty does not prove absence across lists.' },
        ...(status === 'in_progress' ? { note: 'Google Tasks has no in-progress state; showing open tasks.' } : {}),
      };
    }),
  } satisfies ToolHandler<GetTasksArgs, unknown, ToolDispatcherContext>,
  {
    name: 'propose_calendar_change',
    description: "Propose adding, moving or cancelling an event on the owner's calendar. The owner gets a review card to approve, change or skip; nothing changes until they approve. Include the event title. calendar_id (from query_calendar list_calendars) picks a calendar other than the primary one. A new event can invite attendees, with a location, notes and a Meet link; with attendees, send_updates says whether Google emails them, and for a move or cancel of an event that has guests it says the same. The card shows the owner exactly who is invited and whether they are emailed. A new block of protected time says its kind in block: rest or deep_work.",
    schema: proposeCalendarChangeArgsSchema,
    trigger_allowlist: allowlist('propose_calendar_change'),
    autonomy_gated: false,
    requires_connector: true,
    eligible: granted(google, 'calendar'),
    mutates_state: true,
    proposal_only: true,
    async handle(args: ProposeCalendarChangeArgs, ctx?: ToolDispatcherContext) {
      const result = await withGoogle(google, 'calendar', ctx, async client => {
        const proposal_id = await desk.propose({...args, ...(client.account?.email ? {account:client.account.email} : {})}, ctx?.turnId, await ownerEffectOperationRef(ctx));
        return { proposal_id, status: proposalStatus(desk.placement?.(proposal_id), 'sent to the owner with Do it / Modify / Not now buttons', 'Nothing has changed.'), applied: false };
      }, args.account);
      return result.ok ? {...result, source_taint:null} : result;
    },
  } satisfies ToolHandler<ProposeCalendarChangeArgs, unknown, ToolDispatcherContext>,
  {
    name: 'draft_email',
    description: "Save an email draft in the owner's Gmail. It is not sent; the owner reviews and sends it themselves. When the owner says to email themselves, read their connected account address with connect_service instead of asking for it. To reply to all, address the replied-to message's reply_to (or its sender when there is none) and copy its to and cc, leaving out the owner's own address (account.email in read_thread); a plain reply goes to reply_to or the sender only.",
    schema: draftEmailArgsSchema,
    trigger_allowlist: allowlist('draft_email'),
    autonomy_gated: false,
    requires_connector: true,
    eligible: granted(google, 'mail'),
    mutates_state: true,
    handle: async (args: DraftEmailArgs, ctx?: ToolDispatcherContext) => {
      if (!ctx?.turnId || !ctx.toolCallId) return { ok: false as const, code: 'rejected' as const, error: 'Draft invocation identity is unavailable.' };
      const intent = { id: `draft:${await sha256Hex(JSON.stringify([ctx.authenticatedUserId,ctx.turnId,ctx.toolCallId]))}` };
      const access: GoogleAccess = { client: (feature, _intent, guard, account) => google.client(feature,intent,guard,account) };
      const result = await withGoogle(access, 'mail', ctx, async (client) => {
        const input = {
          ...await replyHeaders(client, args),
          to: args.to, ...(args.cc ? { cc: args.cc } : {}), ...(args.bcc ? { bcc: args.bcc } : {}),
          subject: args.subject, body: args.body_markdown, ...(args.reply_to_thread_id ? { threadId: args.reply_to_thread_id } : {}),
          messageId: `<${intent.id.slice(6)}@waldo-draft>`,
        };
        const draft = effects ? (await effects.execute({ operationId: intent.id, owner_ref: ctx.authenticatedUserId, tool: 'draft_email', payload: input }, {
          dispatch: async () => { const result = await client.draft(input); return { provider_id: result.draft_id, result }; },
          reconcile: async () => { const result = await client.findDraftByMessageId?.(input.messageId); return result ? { status: 'done', receipt: { provider_id: result.draft_id, result } } : { status: 'unknown' }; },
        })).result as Awaited<ReturnType<GoogleClient['draft']>> : await client.draft(input);
        desk.record('email_draft', `Drafted "${args.subject}" to ${args.to.join(', ')}`, draft);
        return { ...draft, sent: false };
      }, args.account);
      return result.ok ? { ...result, source_taint: null } : result;
    },
  } satisfies ToolHandler<DraftEmailArgs, unknown, ToolDispatcherContext>,
  {
    name: 'send_email',
    description: "Send an email from the owner's Gmail. The owner gets a review card showing the exact recipients, subject and body; nothing sends until they approve. A request to draft an email and send it once they approve is this tool: the card is the draft they approve. Use draft_email only when they want a saved Gmail draft to edit themselves. An earlier send whose outcome is unknown does not stop a new proposal the owner asks for: if an identical email may already have gone out, the card says so and the owner decides. When the owner says to email themselves, read their connected account address with connect_service instead of asking for it. To reply to all, address the replied-to message's reply_to (or its sender when there is none) and copy its to and cc, leaving out the owner's own address (account.email in read_thread); a plain reply goes to reply_to or the sender only.",
    schema: sendEmailArgsSchema,
    trigger_allowlist: allowlist('send_email'),
    autonomy_gated: false,
    requires_connector: true,
    eligible: granted(google, 'mail'),
    mutates_state: true,
    proposal_only: true,
    // The tool only proposes: it canonicalizes the MIME bytes, binds them with a sha256 digest
    // and hands both to the approval desk. The desk replays the stored bytes on approval
    // (users.messages.send, never drafts.send) and reconciles an ambiguous send through the
    // Message-ID we set, so the model's post-approval state cannot change what goes out.
    handle: async (args: SendEmailArgs, ctx?: ToolDispatcherContext) => {
      // Connectivity is gated at propose time (same tier-2 contract as the other google
      // handlers): no client -> typed connect intent, no half-proposed card.
      const gate = await withGoogle(google, 'mail', ctx, async client => ({account: client.account ?? {connection_id:null,email:null}, reply: await replyHeaders(client, args)}), args.account);
      if (!gate.ok) return { ...gate, source_taint: null };
      // A replay of the same ingress turn with the same final email arguments must reuse its
      // proposal, even though each invocation mints fresh wire Message-ID bytes. Later turns
      // may request an identical email deliberately; their distinct turn IDs stay independent.
      const dedupe_key = ctx?.turnId ? await sha256Hex(JSON.stringify([ctx.authenticatedUserId, ctx.turnId, args])) : undefined;
      const message_id = `<${crypto.randomUUID()}@waldo-send>`;
      // The digest-bound bytes are exactly what crosses the Gmail wire: base64url MIME.
      // (buildMime returns the MIME TEXT; messages/send rejects it unencoded - google 400
      // "Base64 decoding failed" on the approved send path.)
      const raw = b64url(new TextEncoder().encode(buildMime({
        to: args.to, ...(args.cc ? { cc: args.cc } : {}), ...(args.bcc ? { bcc: args.bcc } : {}),
        subject: args.subject, body: args.body_markdown, messageId: message_id, ...gate.data.reply,
      })));
      try {
        const proposal_id = await desk.proposeSendEmail({
          operation_ref: await ownerEffectOperationRef(ctx),
          to: args.to, ...(args.cc ? { cc: args.cc } : {}), ...(args.bcc ? { bcc: args.bcc } : {}),
          subject: args.subject, body: args.body_markdown,
          ...(gate.data.account.email ? {account:gate.data.account.email} : {}),
          ...(args.reply_to_thread_id ? { thread_id: args.reply_to_thread_id } : {}),
          ...gate.data.reply, message_id, raw, digest: await sha256Hex(raw), ...(dedupe_key ? { dedupe_key } : {}),
        });
        return { ok: true, data: { account: gate.data.account, proposal_id, status: proposalStatus(desk.placement?.(proposal_id), 'review card requested in chat; nothing was sent', 'Nothing was sent.'), sent: false }, source_taint: null };
      } catch (error) {
        // A channel timeout may have delivered the card, but no email was sent and the
        // proposal remains blocked. Database/other faults are not card-delivery evidence.
        if (!(error instanceof EmailProposalError)) return { ok: false, code: 'transient', error: 'The email proposal could not be prepared. No email was sent; check chat before retrying.', source_taint: 'external' };
        const reason = error.reason === 'card_unconfirmed'
          ? 'The email review card delivery was not confirmed. No email was sent. Check chat before asking for a fresh proposal.'
          : error.reason === 'identifier_reused'
            ? 'The email proposal identifier was reused with changed content. No email was sent; ask for a fresh proposal.'
            : 'This email proposal was already handled. No new email was sent; check chat before asking again.';
        return { ok: false, code: 'rejected', error: reason, source_taint: 'external' };
      }
    },
  } satisfies ToolHandler<SendEmailArgs, unknown, ToolDispatcherContext>,
  {
    name:'query_availability',description:"Find free time: the windows of at least duration_minutes that are free across the given calendars and supplied work windows. Use it whenever the owner asks when they are free or for a slot, and offer only windows it returns: each is already computed, with start and end in the owner's time zone and its length in minutes, so never work out free time from query_calendar events. Set duration_minutes to the length the owner needs, and include every calendar that holds their commitments (list them with query_calendar list_calendars). Busy blocks are Google's own free/busy answer for those calendars. A calendar that cannot be read is never free: free_windows stays empty and windows_free_on_answered_calendars holds time free on the calendars that answered, to offer only as tentative. Without account, primary means every connected account's primary calendar. Read-only, no booking.",
    schema:queryAvailabilityArgsSchema,trigger_allowlist:allowlist('query_availability'),autonomy_gated:false,requires_connector:true,
    // state() does not report the freebusy scope; calendar is its superset here, and a missing scope still returns a connect intent.
    eligible:granted(google,'calendar'),
    handle:async(args:QueryAvailabilityArgs, ctx?: ToolDispatcherContext)=>{
      const {date_range:range,calendar_ids:ids,work_windows:windows,duration_minutes:duration}=args;
      const observe=async(client:GoogleClient)=>{
        const observed=await client.freeBusy(range.from,range.to,ids,clock.timezone);
        if(Date.parse(observed.from)!==Date.parse(range.from)||Date.parse(observed.to)!==Date.parse(range.to))throw new Error('availability coverage differs');
        return observed.calendars??{};
      };
      const freeTime=(ids:readonly string[],calendars:FreeBusyResult['calendars'])=>{
        const unavailable=ids.filter(id=>!validFreeBusyCalendar(calendars[id])||Boolean(calendars[id]!.errors?.length));
        const answered=ids.filter(id=>!unavailable.includes(id));
        if(!answered.length)return {status:'unknown' as const,from:range.from,to:range.to,timezone:clock.timezone,calendar_ids:ids,unavailable_calendar_ids:unavailable,free_windows:[],observed_at:clock.now().toISOString()};
        // An unreadable calendar is never free. The answered calendars' free time is kept apart from free_windows,
        // so the owner can still be offered a tentative slot instead of nothing.
        if(unavailable.length)return {status:'partial_provider_coverage' as const,from:range.from,to:range.to,timezone:clock.timezone,calendar_ids:ids,answered_calendar_ids:answered,unavailable_calendar_ids:unavailable,free_windows:[],
          windows_free_on_answered_calendars:ownerWindows(availabilityWindows(range,answered.flatMap(id=>calendars[id]!.busy),windows,duration),clock.timezone,duration),observed_at:clock.now().toISOString(),
          qualification:`Free only on the calendars that answered. ${unavailable.join(', ')} could not be read and may be busy; offer these as tentative and say which calendar was not checked.`};
        return {status:'complete_provider_coverage' as const,from:range.from,to:range.to,timezone:clock.timezone,calendar_ids:ids,unavailable_calendar_ids:[],free_windows:ownerWindows(availabilityWindows(range,ids.flatMap(id=>calendars[id]!.busy),windows,duration),clock.timezone,duration),observed_at:clock.now().toISOString(),qualification:'Free according to queried calendars and supplied work windows; not a booking or guarantee of personal availability.'};
      };
      const accounts=await accountsToRead(google,'availability',args.account);
      if(accounts.length<2)return withGoogle(google,'availability',ctx,async client=>freeTime(ids,await observe(client)),args.account);
      const read=await readEveryAccount('query_availability','availability',accounts,email=>withGoogle(google,'availability',ctx,async client=>({email,calendars:await observe(client)}),email));
      if(!read.ok)return read;
      // 'primary' is each account's own calendar, whose id is the account's address. Any other id takes the first account
      // that answered it cleanly: an account that cannot see a calendar answers it with an error.
      const clean=(answer:unknown)=>validFreeBusyCalendar(answer)&&!answer.errors?.length;
      const calendars:Record<string,FreeBusyResult['calendars'][string]>={};
      for(const {email,calendars:answers} of read.data.by_account)for(const [id,answer] of Object.entries(answers)){
        const key=id==='primary'?email:id;
        if(!clean(calendars[key]))calendars[key]=answer;
      }
      return {ok:true,source_taint:'external',data:{accounts:read.data.accounts,...freeTime([...new Set(ids.flatMap(id=>id==='primary'?accounts.map(known=>known.email):[id]))],calendars)}};
    },
  } satisfies ToolHandler<QueryAvailabilityArgs,unknown,ToolDispatcherContext>,

];

// The tool only reports the typed intent; the responder turns it into the channel's connect
// affordance (Telegram: a URL button minted at click time). No link ever enters model text.
export const connectServiceHandler = (google: GoogleAccess): ToolHandler<ConnectServiceArgs, Readonly<{service:string;connected:boolean;message:string;accounts?:readonly Readonly<{id:string;email:string;calendar:boolean;mail:boolean;tasks:boolean;health:string;provenance:string}>[]}>, ToolDispatcherContext> => ({
  name: 'connect_service',
  description: 'Read connected Google account addresses and granted feature/health metadata, or connect Google. Pass feature to offer one that is not granted yet. Host account metadata is not evidence that a message sender is the owner. Use whenever the owner asks to connect, link or set up a service, asks why you cannot see their calendar or email, or mentions a connector. The result says whether a connect button reached the owner or where else they connect; never quote or transcribe a link.',
  schema: connectServiceArgsSchema,
  trigger_allowlist: allowlist('connect_service'),
  autonomy_gated: false,
  async handle({ service, feature }: ConnectServiceArgs) {
    if(google.state){
      const state=await google.state();
      if(!Array.isArray(state)||state.some(account=>!account||typeof account.id!=='string'||!account.id||typeof account.email!=='string'||!account.email||account.email.includes('\n')||account.email.includes('\r')||[account.calendar,account.mail,account.tasks].some(v=>typeof v!=='boolean')||(account.error!==null&&typeof account.error!=='string')))return {ok:false,code:'transient',error:'Connected account metadata unavailable.',source_taint:null};
      const accounts=state.map(account=>({id:account.id,email:account.email,calendar:account.calendar,mail:account.mail,tasks:account.tasks,health:account.error?'unhealthy':'no_recorded_error',provenance:'host_connected_account_metadata_not_email_authorship'}));
      if((feature==='calendar'||feature==='mail'||feature==='tasks')&&!state.some(account=>account[feature]))return {ok:false,code:'auth_failed',error:connectNeededText(accounts.length?'scope_missing':'not_connected',feature),connect:{status:'auth_required',service:'google',reason:accounts.length?'scope_missing':'not_connected',feature}};
      if(accounts.length)return {ok:true,data:{service,connected:true,accounts,message:'Connected account metadata only. Granted features and last recorded health do not prove a fresh provider read; message sender identity needs separate verification.'},source_taint:null};
    }
    if (await google.client(feature ?? 'calendar')) {
      return { ok: true, data: { service, connected: true, message: 'Google is already connected.' }, source_taint: null };
    }
    return { ok: false, code: 'auth_failed', error: connectNeededText('not_connected', feature ?? 'calendar'), connect: { status: 'auth_required', service: 'google', reason: 'not_connected', feature: feature ?? 'calendar' } };
  },
});
