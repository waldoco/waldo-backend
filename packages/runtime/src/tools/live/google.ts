import {
  connectServiceArgsSchema, draftEmailArgsSchema, proposeCalendarChangeArgsSchema, queryCalendarArgsSchema, TOOL_PERMISSIONS, triggerTypeSchema,
  type ConnectServiceArgs, type DraftEmailArgs, type ProposeCalendarChangeArgs, type QueryCalendarArgs, type ToolHandler, type ToolName, type ToolResult,
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

async function withGoogle<T>(google: GoogleAccess, feature: GoogleFeature, work: (client: GoogleClient) => Promise<T>): Promise<ToolResult<T>> {
  const client = await google.client(feature);
  if (client === null) {
    const url = await google.connectUrl(feature);
    return {
      ok: false, code: 'auth_failed',
      error: url ? `Google is not connected yet. Give the owner this link to connect their Google account: ${url}` : 'Google is not set up on this Waldo yet, so calendar and email are unavailable.',
    };
  }
  try {
    return { ok: true, data: await work(client), source_taint: 'external' };
  } catch (error) {
    // A 403 means this feature's scope was never granted; consent adds it to the same account.
    const more = error instanceof GoogleError && error.status === 403 ? await google.connectUrl(feature) : null;
    if (more) return { ok: false, code: 'auth_failed', error: `Google has not granted access for this yet. Give the owner this link to allow it: ${more}` };
    return { ok: false, code: 'transient', error: error instanceof Error ? error.message : String(error) };
  }
}

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
    handle: (args: DraftEmailArgs) => withGoogle(google, 'mail', async (client) => {
      const draft = await client.draft({
        to: args.to, ...(args.cc ? { cc: args.cc } : {}), ...(args.bcc ? { bcc: args.bcc } : {}),
        subject: args.subject, body: args.body_markdown, ...(args.reply_to_thread_id ? { threadId: args.reply_to_thread_id } : {}),
      });
      desk.record('email_draft', `Drafted "${args.subject}" to ${args.to.join(', ')}`, draft);
      return { ...draft, sent: false };
    }),
  } satisfies ToolHandler<DraftEmailArgs, unknown, ToolDispatcherContext>,
];

export const connectServiceHandler = (google: GoogleAccess): ToolHandler<ConnectServiceArgs, Readonly<{ service: string; connected: boolean; message: string }>, ToolDispatcherContext> => ({
  name: 'connect_service',
  description: 'Get the link to connect a service (Google today), or confirm it is already connected. Use whenever the owner asks to connect, link or set up a service, asks why you cannot see their calendar or email, or mentions a connector.',
  schema: connectServiceArgsSchema,
  trigger_allowlist: allowlist('connect_service'),
  autonomy_gated: false,
  async handle({ service }: ConnectServiceArgs) {
    if (await google.client('calendar')) {
      return { ok: true, data: { service, connected: true, message: 'Google is already connected.' }, source_taint: null };
    }
    const url = await google.connectUrl('calendar');
    return {
      ok: true,
      data: url
        ? { service, connected: false, message: `Google is not connected yet. Give the owner this link to connect their Google account: ${url}` }
        : { service, connected: false, message: 'Google is not set up on this Waldo yet, so there is no link to give.' },
      source_taint: null,
    };
  },
});
