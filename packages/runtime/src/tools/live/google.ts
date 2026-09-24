import {
  connectServiceArgsSchema, draftEmailArgsSchema, getCommunicationArgsSchema, proposeCalendarChangeArgsSchema, queryCalendarArgsSchema, TOOL_PERMISSIONS, triggerTypeSchema,
  type ConnectServiceArgs, type DraftEmailArgs, type GetCommunicationArgs, type ProposeCalendarChangeArgs, type QueryCalendarArgs, type ToolHandler, type ToolName, type ToolResult,
} from '@waldo/contracts';
import { GoogleError, type GoogleClient, type GoogleFeature } from '../../connectors/google';
import type { ToolDispatcherContext } from '../dispatcher';
import type { OwnerClock } from './get-context';

export type GoogleAccess = Readonly<{
  client(feature?: GoogleFeature): Promise<GoogleClient | null>;
  connectUrl(feature: GoogleFeature): Promise<string | null>;
}>;

export type EffectDesk = Readonly<{
  propose(proposal: ProposeCalendarChangeArgs): Promise<string>;
  record(kind: string, summary: string, payload: unknown): void;
}>;

const allowlist = (name: ToolName) => triggerTypeSchema.options.filter((trigger) => TOOL_PERMISSIONS[trigger].includes(name));
const DAY_MS = 24 * 60 * 60_000;

export type DeliverConnectLink = (url: string) => Promise<boolean>;

// The consent URL goes out through deliver as a button; the model only learns whether it was sent.
const offerLink = async (google: GoogleAccess, feature: GoogleFeature, deliver: DeliverConnectLink | undefined, lead: string): Promise<string | null> => {
  const url = await google.connectUrl(feature);
  if (!url) return null;
  return deliver && await deliver(url)
    ? `${lead} A connect button was sent in this chat. Tell the owner to tap it - do not quote or retype any link yourself.`
    : `${lead} The connect link could not be sent in this chat. Ask the owner to request it again from their Telegram chat with Waldo.`;
};

async function withGoogle<T>(google: GoogleAccess, feature: GoogleFeature, deliver: DeliverConnectLink | undefined, work: (client: GoogleClient) => Promise<T>): Promise<ToolResult<T>> {
  const client = await google.client(feature);
  if (client === null) {
    return {
      ok: false, code: 'auth_failed',
      error: await offerLink(google, feature, deliver, 'Google is not connected yet.') ?? 'Google is not set up on this Waldo yet, so calendar and email are unavailable.',
    };
  }
  try {
    return { ok: true, data: await work(client), source_taint: 'external' };
  } catch (error) {
    // A 403 means this feature's scope was never granted; consent adds it to the same account.
    const more = error instanceof GoogleError && error.status === 403 ? await offerLink(google, feature, deliver, 'Google has not granted access for this yet.') : null;
    if (more) return { ok: false, code: 'auth_failed', error: more };
    return { ok: false, code: 'transient', error: error instanceof Error ? error.message : String(error) };
  }
}

export const googleHandlers = (google: GoogleAccess, desk: EffectDesk, clock: OwnerClock, deliver?: DeliverConnectLink) => [
  {
    name: 'query_calendar',
    description: "Read the owner's Google Calendar events in a time range (defaults to now through the next 24 hours).",
    schema: queryCalendarArgsSchema,
    trigger_allowlist: allowlist('query_calendar'),
    autonomy_gated: false,
    handle: ({ date_range, include_declined, limit }: QueryCalendarArgs) => withGoogle(google, 'calendar', deliver, async (client) => {
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
    handle: ({ date_range }: GetCommunicationArgs) => withGoogle(google, 'mail', deliver, async (client) => {
      const since = date_range?.from ? Date.parse(date_range.from) : clock.now().getTime() - DAY_MS;
      return { since: new Date(since).toISOString(), messages: await client.newMail(since, 10) };
    }),
  } satisfies ToolHandler<GetCommunicationArgs, unknown, ToolDispatcherContext>,
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
    description: "Save an email draft in the owner's Gmail. It is not sent; the owner reviews and sends it themselves.",
    schema: draftEmailArgsSchema,
    trigger_allowlist: allowlist('draft_email'),
    autonomy_gated: false,
    handle: (args: DraftEmailArgs) => withGoogle(google, 'mail', deliver, async (client) => {
      const draft = await client.draft({
        to: args.to, ...(args.cc ? { cc: args.cc } : {}), ...(args.bcc ? { bcc: args.bcc } : {}),
        subject: args.subject, body: args.body_markdown, ...(args.reply_to_thread_id ? { threadId: args.reply_to_thread_id } : {}),
      });
      desk.record('email_draft', `Drafted "${args.subject}" to ${args.to.join(', ')}`, draft);
      return { ...draft, sent: false };
    }),
  } satisfies ToolHandler<DraftEmailArgs, unknown, ToolDispatcherContext>,
];

// The signed consent URL never enters model-visible text: deliver sends it as a Telegram URL button.
export const connectServiceHandler = (google: GoogleAccess, deliver?: DeliverConnectLink): ToolHandler<ConnectServiceArgs, Readonly<{ service: string; connected: boolean; message: string }>, ToolDispatcherContext> => ({
  name: 'connect_service',
  description: 'Connect a service (Google today), or confirm it is already connected. Use whenever the owner asks to connect, link or set up a service, asks why you cannot see their calendar or email, or mentions a connector. The link arrives as a button in chat; never quote or transcribe it.',
  schema: connectServiceArgsSchema,
  trigger_allowlist: allowlist('connect_service'),
  autonomy_gated: false,
  async handle({ service }: ConnectServiceArgs) {
    if (await google.client('calendar')) {
      return { ok: true, data: { service, connected: true, message: 'Google is already connected.' }, source_taint: null };
    }
    const url = await google.connectUrl('calendar');
    if (!url) {
      return { ok: true, data: { service, connected: false, message: 'Google is not set up on this Waldo yet, so there is no link to give.' }, source_taint: null };
    }
    if (!deliver || !(await deliver(url))) {
      return { ok: true, data: { service, connected: false, message: 'The connect link could not be sent in this chat. Ask the owner to request it again from their Telegram chat with Waldo.' }, source_taint: null };
    }
    return { ok: true, data: { service, connected: false, message: 'The Google connect link was sent as a button in this chat. Tell the owner to tap it - do not quote or retype any link yourself.' }, source_taint: null };
  },
});
