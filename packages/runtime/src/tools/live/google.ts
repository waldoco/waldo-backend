import { taskSourceClient } from '../task-source-io';
import { availabilityWindows } from './availability';
import type { ProxyIntent } from '../../connectors/proxy-intent';
import { artifactMarker, extractArtifacts, quarantineArtifacts, type ArtifactKind, type ExtractedArtifact } from '../../security/artifact-hygiene';
import {
  calendarPageSchema, queryAvailabilityArgsSchema, type QueryAvailabilityArgs,
  connectServiceArgsSchema, draftEmailArgsSchema, getCommunicationArgsSchema, readThreadArgsSchema, searchCommunicationArgsSchema, getTasksArgsSchema, proposeCalendarChangeArgsSchema, queryCalendarArgsSchema, sendEmailArgsSchema, TOOL_PERMISSIONS, triggerTypeSchema,
  type ConnectIntent, type ConnectServiceArgs, type DraftEmailArgs, type GetCommunicationArgs, type ReadThreadArgs, type SearchCommunicationArgs, type GetTasksArgs, type ProposeCalendarChangeArgs, type QueryCalendarArgs, type SendEmailArgs, type ToolHandler, type ToolName, type ToolResult,
} from '@waldo/contracts';
import { b64url, buildMime, validFreeBusyCalendar, GoogleError, sha256Hex, type CalendarPage, type GoogleClient, type GoogleFeature } from '../../connectors/google';
import { EmailProposalError, type EmailSendProposal } from '../../channels/approvals';
import type { ToolDispatcherContext } from '../dispatcher';
import type { OwnerClock } from './get-context';

export type GoogleAccess = Readonly<{
  client(feature?: GoogleFeature, intent?: ProxyIntent, assertTaskSourceCurrent?: () => Promise<void>, account?: string): Promise<GoogleClient | null>;
  state?():Promise<readonly Readonly<{id:string;email:string;error:string|null;calendar:boolean;mail:boolean;tasks:boolean}>[]>;
}>;

export type EffectDesk = Readonly<{
  propose(proposal: ProposeCalendarChangeArgs, turnKey?: string): Promise<string>;
  proposeSendEmail(proposal: EmailSendProposal): Promise<string>;
  record(kind: string, summary: string, payload: unknown): void;
}>;

const allowlist = (name: ToolName) => triggerTypeSchema.options.filter((trigger) => TOOL_PERMISSIONS[trigger].includes(name));
const DAY_MS = 24 * 60 * 60_000;

// S4 (CONNECT_FLOW_DESIGN 4.4): auth failures are a typed intent, never a URL in text. The
// responder sees `connect` and calls the channel's offerConnect seam; the model only ever
// reads this fixed sentence.
const CONNECT_SENT_TEXT = 'A connect button is in the chat (or was just sent). Tell the owner to tap it - never quote or retype any link yourself.';
// source_taint 'external': these handlers are external-origin tools (ADR-0049) - the failure
// arm must carry the stamp or the dispatcher rejects the result outright.
const authFailed = (reason: ConnectIntent['reason'], feature: GoogleFeature): ToolResult<never> => ({
  ok: false, code: 'auth_failed', error: CONNECT_SENT_TEXT, source_taint: 'external',
  connect: { status: 'auth_required', service: 'google', reason, feature },
});

async function withGoogle<T extends object>(google: GoogleAccess, feature: GoogleFeature, ctx: ToolDispatcherContext | undefined, work: (client: GoogleClient) => Promise<T>, account?: string): Promise<ToolResult<T>> {
  const client = await google.client(feature, undefined, ctx?.assertTaskSourceCurrent, account);
  if (client === null) {
    // No serving client while a connected account is failing (invalid_grant recorded, circuit
    // open) asks for a reconnect, not a fresh connect. Accounts without the feature stay a
    // connection gap.
    const accounts = google.state ? await google.state() : undefined;
    const dead = (feature === 'calendar' || feature === 'mail' || feature === 'tasks') && (accounts?.some((known) => (!account || known.email.toLowerCase() === account.toLowerCase()) && known.error !== null && known[feature]) ?? false);
    return authFailed(dead ? 'reauth_needed' : 'not_connected', feature);
  }
  try {
    if (account && client.account?.email?.toLowerCase() !== account.toLowerCase()) throw new Error('Selected Google account is unavailable; no other account was used');
    const data = await work(taskSourceClient(client, ctx));
    return { ok: true, data: { ...data, account: client.account ?? {connection_id:null,email:null} }, source_taint: 'external' };
  } catch (error) {
    // 401 = the stored grant is dead. A 403 prompts for consent only on structured evidence that the scope is
    // missing; a disabled API, a quota or a plain denial is not fixed by consent, so it returns the provider's words.
    if (error instanceof GoogleError && error.status === 403 && error.reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT') return authFailed('scope_missing', feature);
    if (error instanceof GoogleError && error.status === 403) return { ok: false, code: 'rejected', error: `Google refused the request (403${error.reason === 'SERVICE_DISABLED' ? ', the API is disabled for this project' : ''}): ${error.message}`, source_taint: 'external' };
    if (error instanceof GoogleError && error.status === 401) return authFailed('reauth_needed', feature);
    return { ok: false, code: 'transient', error: error instanceof Error ? error.message : String(error), source_taint: 'external' };
  }
}

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
const relayThreadMessage = async <T extends { subject: string; body: string; from: string }>(item: T, relay: ArtifactRelay | undefined): Promise<T & { quarantined?: readonly ArtifactKind[] }> => {
  const subject = extractArtifacts(item.subject);
  const body = extractArtifacts(item.body);
  const artifacts = [...subject.artifacts, ...body.artifacts.filter((b) => !subject.artifacts.some((s) => s.value === b.value))];
  if (artifacts.length === 0) return item;
  const kinds = [...new Set(artifacts.map((artifact) => artifact.kind))].sort();
  const relayed = relay !== undefined && await relay(item.from, artifacts).then(() => true, () => false);
  // Only the matched spans are replaced; the rest of subject and body stays readable. A failed or
  // absent relay keeps the source-app marker, never a false sent claim.
  const relayedMarker = (text: string): string => kinds.reduce((t, kind) => t.replaceAll(artifactMarker(kind), `[${kind} artifact - sent to the owner in a separate message]`), text);
  return { ...item, subject: relayed ? relayedMarker(subject.text) : subject.text, body: relayed ? relayedMarker(body.text) : body.text, quarantined: kinds };
};

export const googleHandlers = (google: GoogleAccess, desk: EffectDesk, clock: OwnerClock, relayArtifact?: ArtifactRelay) => [
  {
    name: 'query_calendar',
    description: "Read a bounded page from one connected Google account and calendar (primary by default), now through the next 24 hours by default. Inspect coverage and next_page_token. Continue with the exact explicit date_range, calendar_id, limit and include_declined. Each result contains only its current page: an exhausted continuation does not make that result a complete window. Legacy adapters report unknown account and incomplete coverage. This is event enumeration, not availability.",
    schema: queryCalendarArgsSchema,
    trigger_allowlist: allowlist('query_calendar'),
    autonomy_gated: false,
    requires_connector: true,
    handle: ({ date_range, include_declined, limit, calendar_id = 'primary', page_token, account }: QueryCalendarArgs, ctx?: ToolDispatcherContext) => withGoogle(google, 'calendar', ctx, async (client) => {
      const now = clock.now().getTime();
      const from = date_range?.from ?? new Date(now).toISOString();
      const to = date_range?.to ?? new Date(now + DAY_MS).toISOString();
      let page: CalendarPage | null = null;
      if (typeof client.calendarPage === 'function') {
        try { page = calendarPageSchema.parse(await client.calendarPage(calendar_id, from, to, limit, include_declined, page_token));
          if (page.fetched_count > limit) throw new Error('Calendar page exceeds requested limit'); }
        catch (error) {
          if (!(error instanceof GoogleError && error.status === 404 && error.message === 'unknown operation') || page_token || calendar_id !== 'primary') throw error;
        }
      }
      if (!page && (page_token || calendar_id !== 'primary')) throw new Error('Calendar pagination or selected calendar adapter unavailable');
      const events = page?.events ?? await client.events(from,to,limit,include_declined);
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
    }, account),
  } satisfies ToolHandler<QueryCalendarArgs, unknown, ToolDispatcherContext>,
  {
    name: 'get_communication',
    description: "Read a sampled page from the connected Gmail account's Primary inbox category, not the entire inbox or all accounts. Defaults to a rolling 24-hour window, not today. Inspect coverage and next_page_token, then pass the same date_range with page_token for subsequent pages. Legacy adapters lack pagination; an empty legacy page does not prove no mail in the requested range.",
    schema: getCommunicationArgsSchema,
    trigger_allowlist: allowlist('get_communication'),
    autonomy_gated: false,
    requires_connector: true,
    handle: ({ date_range,limit=10,page_token, account }: GetCommunicationArgs, ctx?: ToolDispatcherContext) => withGoogle(google, 'mail', ctx, async (client) => {
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
    }, account),
  } satisfies ToolHandler<GetCommunicationArgs, unknown, ToolDispatcherContext>,
  {
    name: 'search_communication',
    description: "Search the owner's Gmail by sender, subject or words, optionally in a date range. Returns matching messages with from, subject, snippet, time and thread_id. Space-separated Gmail terms must all match; do not paste a full natural-language ask as the query. Start with distinctive sender/repository/topic terms. An empty match is not absence: try a narrower-term query while preserving the same account, date range and result limit, then report the search limit. Never rewrite a quoted or operator query silently. Use get_communication for 'what is new' instead, and read_thread to read one thread in full. Continue search pages with cursor and the same query/date range/account.",
    schema: searchCommunicationArgsSchema,
    trigger_allowlist: allowlist('search_communication'),
    autonomy_gated: false,
    requires_connector: true,
    handle: ({ query, date_range, limit, cursor, account }: SearchCommunicationArgs, ctx?: ToolDispatcherContext) => withGoogle(google, 'mail', ctx, async (client) => {
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
    }, account),
  } satisfies ToolHandler<SearchCommunicationArgs, unknown, ToolDispatcherContext>,
  {
    name: 'read_thread',
    description: "Read one Gmail thread by thread_id - the messages with sender, subject, time and body. Use after get_communication or search_communication surfaces a thread the owner asks about, before drafting a reply. Continue with cursor and the same thread/account; changed threads require restarting.",
    schema: readThreadArgsSchema,
    trigger_allowlist: allowlist('read_thread'),
    autonomy_gated: false,
    requires_connector: true,
    handle: ({ thread_id, limit, cursor, account }: ReadThreadArgs, ctx?: ToolDispatcherContext) => withGoogle(google, 'mail', ctx, async (client) => {
      if (!client.threadPage) throw new Error('Gmail thread pagination adapter unavailable');
      const page = await client.threadPage(thread_id, limit, cursor);
      return {thread_id, account: client.account ?? {connection_id:null,email:null}, cursor: page.cursor, messages: await Promise.all(page.messages.map(message => relayThreadMessage(message, relayArtifact)))};
    }, account),
  } satisfies ToolHandler<ReadThreadArgs, unknown, ToolDispatcherContext>,
  {
    name: 'get_tasks',
    description: "Read the owner's Google Tasks (default list). Defaults to open tasks. Google Tasks has no in-progress state; asking for it returns the open tasks with a note.",
    schema: getTasksArgsSchema,
    trigger_allowlist: allowlist('get_tasks'),
    autonomy_gated: false,
    requires_connector: true,
    handle: ({ status, limit, account }: GetTasksArgs, ctx?: ToolDispatcherContext) => withGoogle(google, 'tasks', ctx, async (client) => ({
      status,
      tasks: await client.tasks(status, limit),
      ...(status === 'in_progress' ? { note: 'Google Tasks has no in-progress state; showing open tasks.' } : {}),
    }), account),
  } satisfies ToolHandler<GetTasksArgs, unknown, ToolDispatcherContext>,
  {
    name: 'propose_calendar_change',
    description: "Propose adding, moving or cancelling an event on the owner's calendar. The owner gets Do it / Modify / Not now buttons; nothing changes until they approve. Include the event title.",
    schema: proposeCalendarChangeArgsSchema,
    trigger_allowlist: allowlist('propose_calendar_change'),
    autonomy_gated: false,
    requires_connector: true,
    mutates_state: true,
    async handle(args: ProposeCalendarChangeArgs, ctx?: ToolDispatcherContext) {
      const result = await withGoogle(google, 'calendar', ctx, async client => ({
        proposal_id: await desk.propose({...args, ...(client.account?.email ? {account:client.account.email} : {})}, ctx?.turnId),
        status: 'sent to the owner with Do it / Modify / Not now buttons', applied: false,
      }), args.account);
      return result.ok ? {...result, source_taint:null} : result;
    },
  } satisfies ToolHandler<ProposeCalendarChangeArgs, unknown, ToolDispatcherContext>,
  {
    name: 'draft_email',
    description: "Save an email draft in the owner's Gmail. It is not sent; the owner reviews and sends it themselves.",
    schema: draftEmailArgsSchema,
    trigger_allowlist: allowlist('draft_email'),
    autonomy_gated: false,
    requires_connector: true,
    mutates_state: true,
    // The draft receipt is a mutation ack, not provider-controlled content, so the result is
    // restamped taint-null: EXTERNAL_ORIGIN_TOOLS covers reads, and the dispatcher rejects a
    // mismatched stamp ('external' here made every draft result unparseable, 2026-09-25).
    handle: async (args: DraftEmailArgs, ctx?: ToolDispatcherContext) => {
      if (!ctx?.turnId || !ctx.toolCallId) return { ok: false as const, code: 'rejected' as const, error: 'Draft invocation identity is unavailable.' };
      const intent = { id: `draft:${await sha256Hex(JSON.stringify([ctx.authenticatedUserId,ctx.turnId,ctx.toolCallId]))}` };
      const access: GoogleAccess = { client: (feature, _intent, guard, account) => google.client(feature,intent,guard,account) };
      const result = await withGoogle(access, 'mail', ctx, async (client) => {
        const draft = await client.draft({
          to: args.to, ...(args.cc ? { cc: args.cc } : {}), ...(args.bcc ? { bcc: args.bcc } : {}),
          subject: args.subject, body: args.body_markdown, ...(args.reply_to_thread_id ? { threadId: args.reply_to_thread_id } : {}),
        });
        desk.record('email_draft', `Drafted "${args.subject}" to ${args.to.join(', ')}`, draft);
        return { ...draft, sent: false };
      }, args.account);
      return result.ok ? { ...result, source_taint: null } : result;
    },
  } satisfies ToolHandler<DraftEmailArgs, unknown, ToolDispatcherContext>,
  {
    name: 'send_email',
    description: "Send an email from the owner's Gmail. The owner gets Send it / Modify / Not now buttons showing the exact recipients, subject and body; nothing sends until they approve. Use draft_email instead when the owner wants to review or edit it in Gmail themselves.",
    schema: sendEmailArgsSchema,
    trigger_allowlist: allowlist('send_email'),
    autonomy_gated: false,
    requires_connector: true,
    mutates_state: true,
    // The tool only proposes: it canonicalizes the MIME bytes, binds them with a sha256 digest
    // and hands both to the approval desk. The desk replays the stored bytes on approval
    // (users.messages.send, never drafts.send) and reconciles an ambiguous send through the
    // Message-ID we set, so the model's post-approval state cannot change what goes out.
    handle: async (args: SendEmailArgs, ctx?: ToolDispatcherContext) => {
      // Connectivity is gated at propose time (same tier-2 contract as the other google
      // handlers): no client -> typed connect intent, no half-proposed card.
      const gate = await withGoogle(google, 'mail', ctx, async client => ({account: client.account ?? {connection_id:null,email:null}}), args.account);
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
        subject: args.subject, body: args.body_markdown, messageId: message_id,
      })));
      try {
        const proposal_id = await desk.proposeSendEmail({
          to: args.to, ...(args.cc ? { cc: args.cc } : {}), ...(args.bcc ? { bcc: args.bcc } : {}),
          subject: args.subject, body: args.body_markdown,
          ...(gate.data.account.email ? {account:gate.data.account.email} : {}),
          ...(args.reply_to_thread_id ? { thread_id: args.reply_to_thread_id } : {}),
          message_id, raw, digest: await sha256Hex(raw), ...(dedupe_key ? { dedupe_key } : {}),
        });
        return { ok: true, data: { account: gate.data.account, proposal_id, status: 'review card requested in chat; nothing was sent', sent: false }, source_taint: null };
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
    name:'query_availability',description:'Find duration-fitting free windows across explicit connected calendar IDs and supplied work windows. Reports unknown coverage instead of assuming inaccessible calendars are free. Read-only, no booking.',
    schema:queryAvailabilityArgsSchema,trigger_allowlist:allowlist('query_availability'),autonomy_gated:false,requires_connector:true,
    handle:(args:QueryAvailabilityArgs, ctx?: ToolDispatcherContext)=>withGoogle(google,'availability',ctx,async client=>{
      const {date_range:range,calendar_ids:ids,work_windows:windows,duration_minutes:duration}=args;
      const observed=await client.freeBusy(range.from,range.to,ids,clock.timezone);
      if(Date.parse(observed.from)!==Date.parse(range.from)||Date.parse(observed.to)!==Date.parse(range.to))throw new Error('availability coverage differs');
      const unavailable=ids.filter(id=>!validFreeBusyCalendar(observed.calendars?.[id])||Boolean(observed.calendars[id]!.errors?.length));
      if(unavailable.length)return {status:'unknown' as const,from:range.from,to:range.to,timezone:clock.timezone,calendar_ids:ids,unavailable_calendar_ids:unavailable,free_windows:[],observed_at:clock.now().toISOString()};
      return {status:'complete_provider_coverage' as const,from:range.from,to:range.to,timezone:clock.timezone,calendar_ids:ids,unavailable_calendar_ids:[],free_windows:availabilityWindows(range,ids.flatMap(id=>observed.calendars[id]!.busy),windows,duration),observed_at:clock.now().toISOString(),qualification:'Free according to queried calendars and supplied work windows; not a booking or guarantee of personal availability.'};
    },args.account),
  } satisfies ToolHandler<QueryAvailabilityArgs,unknown,ToolDispatcherContext>,

];

// The tool only reports the typed intent; the responder turns it into the channel's connect
// affordance (Telegram: a URL button minted at click time). No link ever enters model text.
export const connectServiceHandler = (google: GoogleAccess): ToolHandler<ConnectServiceArgs, Readonly<{service:string;connected:boolean;message:string;accounts?:readonly Readonly<{id:string;email:string;calendar:boolean;mail:boolean;tasks:boolean;health:string;provenance:string}>[]}>, ToolDispatcherContext> => ({
  name: 'connect_service',
  description: 'Read connected Google account addresses and granted feature/health metadata, or connect Google. Host account metadata is not evidence that a message sender is the owner. Use whenever the owner asks to connect, link or set up a service, asks why you cannot see their calendar or email, or mentions a connector. The link arrives as a button in chat; never quote or transcribe it.',
  schema: connectServiceArgsSchema,
  trigger_allowlist: allowlist('connect_service'),
  autonomy_gated: false,
  async handle({ service }: ConnectServiceArgs) {
    if(google.state){
      const state=await google.state();
      if(!Array.isArray(state)||state.some(account=>!account||typeof account.id!=='string'||!account.id||typeof account.email!=='string'||!account.email||account.email.includes('\n')||account.email.includes('\r')||[account.calendar,account.mail,account.tasks].some(v=>typeof v!=='boolean')||(account.error!==null&&typeof account.error!=='string')))return {ok:false,code:'transient',error:'Connected account metadata unavailable.',source_taint:null};
      const accounts=state.map(account=>({id:account.id,email:account.email,calendar:account.calendar,mail:account.mail,tasks:account.tasks,health:account.error?'unhealthy':'no_recorded_error',provenance:'host_connected_account_metadata_not_email_authorship'}));
      if(accounts.length)return {ok:true,data:{service,connected:true,accounts,message:'Connected account metadata only. Granted features and last recorded health do not prove a fresh provider read; message sender identity needs separate verification.'},source_taint:null};
    }
    if (await google.client('calendar')) {
      return { ok: true, data: { service, connected: true, message: 'Google is already connected.' }, source_taint: null };
    }
    return { ok: false, code: 'auth_failed', error: CONNECT_SENT_TEXT, connect: { status: 'auth_required', service: 'google', reason: 'not_connected', feature: 'calendar' } };
  },
});
