import { availabilityWindows } from './availability';
import type { ProxyIntent } from '../../connectors/proxy-intent';
import { artifactMarker, extractArtifacts, quarantineArtifacts, type ArtifactKind, type ExtractedArtifact } from '../../security/artifact-hygiene';
import {
  queryAvailabilityArgsSchema, type QueryAvailabilityArgs,
  connectServiceArgsSchema, draftEmailArgsSchema, getCommunicationArgsSchema, readThreadArgsSchema, searchCommunicationArgsSchema, getTasksArgsSchema, proposeCalendarChangeArgsSchema, queryCalendarArgsSchema, sendEmailArgsSchema, TOOL_PERMISSIONS, triggerTypeSchema,
  type ConnectIntent, type ConnectServiceArgs, type DraftEmailArgs, type GetCommunicationArgs, type ReadThreadArgs, type SearchCommunicationArgs, type GetTasksArgs, type ProposeCalendarChangeArgs, type QueryCalendarArgs, type SendEmailArgs, type ToolHandler, type ToolName, type ToolResult,
} from '@waldo/contracts';
import { b64url, buildMime, validFreeBusyCalendar, GoogleError, sha256Hex, type GoogleClient, type GoogleFeature } from '../../connectors/google';
import { EmailProposalError, type EmailSendProposal } from '../../channels/approvals';
import type { ToolDispatcherContext } from '../dispatcher';
import type { OwnerClock } from './get-context';

export type GoogleAccess = Readonly<{
  client(feature?: GoogleFeature, intent?: ProxyIntent): Promise<GoogleClient | null>;
}>;

export type EffectDesk = Readonly<{
  propose(proposal: ProposeCalendarChangeArgs): Promise<string>;
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

async function withGoogle<T>(google: GoogleAccess, feature: GoogleFeature, work: (client: GoogleClient) => Promise<T>): Promise<ToolResult<T>> {
  const client = await google.client(feature);
  if (client === null) return authFailed('not_connected', feature);
  try {
    return { ok: true, data: await work(client), source_taint: 'external' };
  } catch (error) {
    // A 403 means this feature's scope was never granted; a 401 means the stored grant is dead.
    if (error instanceof GoogleError && error.status === 403) return authFailed('scope_missing', feature);
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
  const extracted = extractArtifacts(`${item.subject}
${item.body}`);
  if (extracted.artifacts.length === 0) return item;
  const kinds = [...new Set(extracted.artifacts.map((artifact) => artifact.kind))].sort();
  const relayed = relay !== undefined && await relay(item.from, extracted.artifacts).then(() => true, () => false);
  const marker = relayed
    ? `[${kinds.join('/')} artifact - sent to the owner in a separate message]`
    : kinds.map(artifactMarker).join(' ');
  return { ...item, subject: marker, body: marker, quarantined: kinds };
};

export const googleHandlers = (google: GoogleAccess, desk: EffectDesk, clock: OwnerClock, relayArtifact?: ArtifactRelay) => [
  {
    name: 'query_calendar',
    description: "Read the owner's Google Calendar events in a time range (defaults to now through the next 24 hours).",
    schema: queryCalendarArgsSchema,
    trigger_allowlist: allowlist('query_calendar'),
    autonomy_gated: false,
    handle: ({ date_range, include_declined, limit }: QueryCalendarArgs) => withGoogle(google, 'calendar', async (client) => {
      const now = clock.now().getTime();
      const from = date_range?.from ?? new Date(now).toISOString();
      const to = date_range?.to ?? new Date(now + DAY_MS).toISOString();
      return { timezone: clock.timezone, from, to, events: await client.events(from, to, limit, include_declined) };
    }),
  } satisfies ToolHandler<QueryCalendarArgs, unknown, ToolDispatcherContext>,
  {
    name: 'get_communication',
    description: "Read the owner's Gmail inbox - recent messages with from, subject, snippet and time. Defaults to the last 24 hours. Use when the owner asks about email or messages.",
    schema: getCommunicationArgsSchema,
    trigger_allowlist: allowlist('get_communication'),
    autonomy_gated: false,
    handle: ({ date_range }: GetCommunicationArgs) => withGoogle(google, 'mail', async (client) => {
      const since = date_range?.from ? Date.parse(date_range.from) : clock.now().getTime() - DAY_MS;
      return { since: new Date(since).toISOString(), messages: (await client.newMail(since, 10)).map(quarantineMailItem) };
    }),
  } satisfies ToolHandler<GetCommunicationArgs, unknown, ToolDispatcherContext>,
  {
    name: 'search_communication',
    description: "Search the owner's Gmail by sender, subject or words, optionally in a date range. Returns matching messages with from, subject, snippet, time and thread_id. Use get_communication for 'what is new' instead, and read_thread to read one thread in full.",
    schema: searchCommunicationArgsSchema,
    trigger_allowlist: allowlist('search_communication'),
    autonomy_gated: false,
    handle: ({ query, date_range, limit }: SearchCommunicationArgs) => withGoogle(google, 'mail', async (client) => {
      const clauses = [query];
      if (date_range?.from) clauses.push(`after:${Math.floor(Date.parse(date_range.from) / 1000)}`);
      if (date_range?.to) clauses.push(`before:${Math.floor(Date.parse(date_range.to) / 1000)}`);
      return { query, messages: (await client.searchMail(clauses.join(' '), limit)).map(quarantineMailItem) };
    }),
  } satisfies ToolHandler<SearchCommunicationArgs, unknown, ToolDispatcherContext>,
  {
    name: 'read_thread',
    description: "Read one Gmail thread by thread_id - the messages with sender, subject, time and body. Use after get_communication or search_communication surfaces a thread the owner asks about, before drafting a reply.",
    schema: readThreadArgsSchema,
    trigger_allowlist: allowlist('read_thread'),
    autonomy_gated: false,
    handle: ({ thread_id, limit }: ReadThreadArgs) => withGoogle(google, 'mail', async (client) => ({
      thread_id,
      messages: await Promise.all((await client.readThread(thread_id, limit)).map((message) => relayThreadMessage(message, relayArtifact))),
    })),
  } satisfies ToolHandler<ReadThreadArgs, unknown, ToolDispatcherContext>,
  {
    name: 'get_tasks',
    description: "Read the owner's Google Tasks (default list). Defaults to open tasks. Google Tasks has no in-progress state; asking for it returns the open tasks with a note.",
    schema: getTasksArgsSchema,
    trigger_allowlist: allowlist('get_tasks'),
    autonomy_gated: false,
    handle: ({ status, limit }: GetTasksArgs) => withGoogle(google, 'tasks', async (client) => ({
      status,
      tasks: await client.tasks(status, limit),
      ...(status === 'in_progress' ? { note: 'Google Tasks has no in-progress state; showing open tasks.' } : {}),
    })),
  } satisfies ToolHandler<GetTasksArgs, unknown, ToolDispatcherContext>,
  {
    name: 'propose_calendar_change',
    description: "Propose adding, moving or cancelling an event on the owner's calendar. The owner gets Do it / Modify / Not now buttons; nothing changes until they approve. Include the event title.",
    schema: proposeCalendarChangeArgsSchema,
    trigger_allowlist: allowlist('propose_calendar_change'),
    autonomy_gated: false,
    mutates_state: true,
    async handle(args: ProposeCalendarChangeArgs) {
      return { ok: true, data: { proposal_id: await desk.propose(args), status: 'sent to the owner with Do it / Modify / Not now buttons', applied: false }, source_taint: null };
    },
  } satisfies ToolHandler<ProposeCalendarChangeArgs, unknown, ToolDispatcherContext>,
  {
    name: 'draft_email',
    description: "Save an email draft in the owner's Gmail. It is not sent; the owner reviews and sends it themselves.",
    schema: draftEmailArgsSchema,
    trigger_allowlist: allowlist('draft_email'),
    autonomy_gated: false,
    mutates_state: true,
    // The draft receipt is a mutation ack, not provider-controlled content, so the result is
    // restamped taint-null: EXTERNAL_ORIGIN_TOOLS covers reads, and the dispatcher rejects a
    // mismatched stamp ('external' here made every draft result unparseable, 2026-09-25).
    handle: async (args: DraftEmailArgs, ctx?: ToolDispatcherContext) => {
      if (!ctx?.turnId || !ctx.toolCallId) return { ok: false as const, code: 'rejected' as const, error: 'Draft invocation identity is unavailable.' };
      const intent = { id: `draft:${await sha256Hex(JSON.stringify([ctx.authenticatedUserId,ctx.turnId,ctx.toolCallId]))}` };
      const access: GoogleAccess = { client: (feature) => google.client(feature,intent) };
      const result = await withGoogle(access, 'mail', async (client) => {
        const draft = await client.draft({
          to: args.to, ...(args.cc ? { cc: args.cc } : {}), ...(args.bcc ? { bcc: args.bcc } : {}),
          subject: args.subject, body: args.body_markdown, ...(args.reply_to_thread_id ? { threadId: args.reply_to_thread_id } : {}),
        });
        desk.record('email_draft', `Drafted "${args.subject}" to ${args.to.join(', ')}`, draft);
        return { ...draft, sent: false };
      });
      return result.ok ? { ...result, source_taint: null } : result;
    },
  } satisfies ToolHandler<DraftEmailArgs, unknown, ToolDispatcherContext>,
  {
    name: 'send_email',
    description: "Send an email from the owner's Gmail. The owner gets Send it / Modify / Not now buttons showing the exact recipients, subject and body; nothing sends until they approve. Use draft_email instead when the owner wants to review or edit it in Gmail themselves.",
    schema: sendEmailArgsSchema,
    trigger_allowlist: allowlist('send_email'),
    autonomy_gated: false,
    mutates_state: true,
    // The tool only proposes: it canonicalizes the MIME bytes, binds them with a sha256 digest
    // and hands both to the approval desk. The desk replays the stored bytes on approval
    // (users.messages.send, never drafts.send) and reconciles an ambiguous send through the
    // Message-ID we set, so the model's post-approval state cannot change what goes out.
    handle: async (args: SendEmailArgs, ctx?: ToolDispatcherContext) => {
      // Connectivity is gated at propose time (same tier-2 contract as the other google
      // handlers): no client -> typed connect intent, no half-proposed card.
      const gate = await withGoogle(google, 'mail', async () => null);
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
          ...(args.reply_to_thread_id ? { thread_id: args.reply_to_thread_id } : {}),
          message_id, raw, digest: await sha256Hex(raw), ...(dedupe_key ? { dedupe_key } : {}),
        });
        return { ok: true, data: { proposal_id, status: 'review card requested in chat; nothing was sent', sent: false }, source_taint: null };
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
    schema:queryAvailabilityArgsSchema,trigger_allowlist:allowlist('query_availability'),autonomy_gated:false,
    handle:(args:QueryAvailabilityArgs)=>withGoogle(google,'availability',async client=>{
      const {date_range:range,calendar_ids:ids,work_windows:windows,duration_minutes:duration}=args;
      const observed=await client.freeBusy(range.from,range.to,ids,clock.timezone);
      if(Date.parse(observed.from)!==Date.parse(range.from)||Date.parse(observed.to)!==Date.parse(range.to))throw new Error('availability coverage differs');
      const unavailable=ids.filter(id=>!validFreeBusyCalendar(observed.calendars?.[id])||Boolean(observed.calendars[id]!.errors?.length));
      if(unavailable.length)return {status:'unknown' as const,from:range.from,to:range.to,timezone:clock.timezone,calendar_ids:ids,unavailable_calendar_ids:unavailable,free_windows:[],observed_at:clock.now().toISOString()};
      return {status:'complete_provider_coverage' as const,from:range.from,to:range.to,timezone:clock.timezone,calendar_ids:ids,unavailable_calendar_ids:[],free_windows:availabilityWindows(range,ids.flatMap(id=>observed.calendars[id]!.busy),windows,duration),observed_at:clock.now().toISOString(),qualification:'Free according to queried calendars and supplied work windows; not a booking or guarantee of personal availability.'};
    }),
  } satisfies ToolHandler<QueryAvailabilityArgs,unknown,ToolDispatcherContext>,

];

// The tool only reports the typed intent; the responder turns it into the channel's connect
// affordance (Telegram: a URL button minted at click time). No link ever enters model text.
export const connectServiceHandler = (google: GoogleAccess): ToolHandler<ConnectServiceArgs, Readonly<{ service: string; connected: boolean; message: string }>, ToolDispatcherContext> => ({
  name: 'connect_service',
  description: 'Connect a service (Google today), or confirm it is already connected. Use whenever the owner asks to connect, link or set up a service, asks why you cannot see their calendar or email, or mentions a connector. The link arrives as a button in chat; never quote or transcribe it.',
  schema: connectServiceArgsSchema,
  trigger_allowlist: allowlist('connect_service'),
  autonomy_gated: false,
  async handle({ service }: ConnectServiceArgs) {
    if (await google.client('calendar')) {
      return { ok: true, data: { service, connected: true, message: 'Google is already connected.' }, source_taint: null };
    }
    return { ok: false, code: 'auth_failed', error: CONNECT_SENT_TEXT, connect: { status: 'auth_required', service: 'google', reason: 'not_connected', feature: 'calendar' } };
  },
});
