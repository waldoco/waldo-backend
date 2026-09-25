import { artifactMarker, quarantineArtifacts, type ArtifactKind } from '../../security/artifact-hygiene';
import {
  connectServiceArgsSchema, draftEmailArgsSchema, getCommunicationArgsSchema, getTasksArgsSchema, proposeCalendarChangeArgsSchema, queryCalendarArgsSchema, sendEmailArgsSchema, TOOL_PERMISSIONS, triggerTypeSchema,
  type ConnectIntent, type ConnectServiceArgs, type DraftEmailArgs, type GetCommunicationArgs, type GetTasksArgs, type ProposeCalendarChangeArgs, type QueryCalendarArgs, type SendEmailArgs, type ToolHandler, type ToolName, type ToolResult,
} from '@waldo/contracts';
import { buildMime, GoogleError, sha256Hex, type GoogleClient, type GoogleFeature } from '../../connectors/google';
import type { EmailSendProposal } from '../../channels/approvals';
import type { ToolDispatcherContext } from '../dispatcher';
import type { OwnerClock } from './get-context';

export type GoogleAccess = Readonly<{
  client(feature?: GoogleFeature): Promise<GoogleClient | null>;
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
    return { ok: false, code: 'transient', error: error instanceof Error ? error.message : String(error) };
  }
}

// E1 (issue #150): a verification artifact in either visible field quarantines both - the
// snippet routinely re-states a code the subject hides, and vice versa. from/at/id stay so the
// owner can find the item in Gmail itself; the raw artifact never enters model context.
const quarantineMailItem = <T extends { subject: string; snippet: string }>(item: T): T & { quarantined?: readonly ArtifactKind[] } => {
  const q = quarantineArtifacts(`${item.subject}
${item.snippet}`);
  if (q.kinds.length === 0) return item;
  const marker = q.kinds.map(artifactMarker).join(' ');
  return { ...item, subject: marker, snippet: marker, quarantined: q.kinds };
};

export const googleHandlers = (google: GoogleAccess, desk: EffectDesk, clock: OwnerClock) => [
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
    async handle(args: ProposeCalendarChangeArgs) {
      return { ok: true, data: { proposal_id: await desk.propose(args), status: 'sent to the owner with Do it / Modify / Not now buttons', applied: false }, source_taint: null };
    },
  } satisfies ToolHandler<ProposeCalendarChangeArgs, unknown, ToolDispatcherContext>,
  {
    name: 'draft_email',
    description: "Save an email draft in the owner's Gmail. It is not sent; the owner reviews and sends it themselves. It creates NO approval card and nothing enters the owner's approval queue - when the owner asked to send, or asked to approve first, use send_email instead.",
    schema: draftEmailArgsSchema,
    trigger_allowlist: allowlist('draft_email'),
    autonomy_gated: false,
    // The draft receipt is a mutation ack, not provider-controlled content, so the result is
    // restamped taint-null: EXTERNAL_ORIGIN_TOOLS covers reads, and the dispatcher rejects a
    // mismatched stamp ('external' here made every draft result unparseable, 2026-09-25).
    handle: async (args: DraftEmailArgs) => {
      const result = await withGoogle(google, 'mail', async (client) => {
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
    // The tool only proposes: it canonicalizes the MIME bytes, binds them with a sha256 digest
    // and hands both to the approval desk. The desk replays the stored bytes on approval
    // (users.messages.send, never drafts.send) and reconciles an ambiguous send through the
    // Message-ID we set, so the model's post-approval state cannot change what goes out.
    handle: async (args: SendEmailArgs) => {
      // Connectivity is gated at propose time (same tier-2 contract as the other google
      // handlers): no client -> typed connect intent, no half-proposed card.
      const gate = await withGoogle(google, 'mail', async () => null);
      if (!gate.ok) return { ...gate, source_taint: null };
      const message_id = `<${crypto.randomUUID()}@waldo-send>`;
      const raw = buildMime({
        to: args.to, ...(args.cc ? { cc: args.cc } : {}), ...(args.bcc ? { bcc: args.bcc } : {}),
        subject: args.subject, body: args.body_markdown, messageId: message_id,
      });
      const proposal_id = await desk.proposeSendEmail({
        to: args.to, ...(args.cc ? { cc: args.cc } : {}), ...(args.bcc ? { bcc: args.bcc } : {}),
        subject: args.subject, body: args.body_markdown,
        ...(args.reply_to_thread_id ? { thread_id: args.reply_to_thread_id } : {}),
        message_id, raw, digest: await sha256Hex(raw),
      });
      return { ok: true, data: { proposal_id, status: 'sent to the owner with Send it / Modify / Not now buttons', sent: false }, source_taint: null };
    },
  } satisfies ToolHandler<SendEmailArgs, unknown, ToolDispatcherContext>,
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
