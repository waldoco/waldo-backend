import {
  draftEmailArgsSchema, proposeCalendarChangeArgsSchema, queryCalendarArgsSchema, TOOL_PERMISSIONS, triggerTypeSchema,
  type DraftEmailArgs, type ProposeCalendarChangeArgs, type QueryCalendarArgs, type ToolHandler, type ToolName, type ToolResult,
} from '@waldo/contracts';
import type { GoogleClient } from '../../connectors/google';
import type { ToolDispatcherContext } from '../dispatcher';
import type { OwnerClock } from './get-context';

export type GoogleAccess = Readonly<{
  client(): Promise<GoogleClient | null>;
  connectUrl(): Promise<string | null>;
}>;

export type EffectDesk = Readonly<{
  propose(proposal: ProposeCalendarChangeArgs): Promise<string>;
  record(kind: string, summary: string, payload: unknown): void;
}>;

const allowlist = (name: ToolName) => triggerTypeSchema.options.filter((trigger) => TOOL_PERMISSIONS[trigger].includes(name));
const DAY_MS = 24 * 60 * 60_000;

async function withGoogle<T>(google: GoogleAccess, work: (client: GoogleClient) => Promise<T>): Promise<ToolResult<T>> {
  const client = await google.client();
  if (client === null) {
    const url = await google.connectUrl();
    return {
      ok: false, code: 'auth_failed',
      error: url ? `Google is not connected yet. Give the owner this link to connect their Google account: ${url}` : 'Google is not set up on this Waldo yet, so calendar and email are unavailable.',
    };
  }
  try {
    return { ok: true, data: await work(client), source_taint: 'external' };
  } catch (error) {
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
    handle: ({ date_range, include_declined, limit }: QueryCalendarArgs) => withGoogle(google, async (client) => {
      const now = clock.now().getTime();
      const from = date_range?.from ?? new Date(now).toISOString();
      const to = date_range?.to ?? new Date(now + DAY_MS).toISOString();
      return { timezone: clock.timezone, from, to, events: await client.events(from, to, limit, include_declined) };
    }),
  } satisfies ToolHandler<QueryCalendarArgs, unknown, ToolDispatcherContext>,
  {
    name: 'propose_calendar_change',
    description: "Propose adding, moving or cancelling an event on the owner's calendar. The owner gets Approve / Change / Skip buttons; nothing changes until they approve. Include the event title.",
    schema: proposeCalendarChangeArgsSchema,
    trigger_allowlist: allowlist('propose_calendar_change'),
    autonomy_gated: false,
    async handle(args: ProposeCalendarChangeArgs) {
      return { ok: true, data: { proposal_id: await desk.propose(args), status: 'sent to the owner with Approve / Change / Skip buttons', applied: false }, source_taint: null };
    },
  } satisfies ToolHandler<ProposeCalendarChangeArgs, unknown, ToolDispatcherContext>,
  {
    name: 'draft_email',
    description: "Save an email draft in the owner's Gmail. It is not sent; the owner reviews and sends it themselves.",
    schema: draftEmailArgsSchema,
    trigger_allowlist: allowlist('draft_email'),
    autonomy_gated: false,
    handle: (args: DraftEmailArgs) => withGoogle(google, async (client) => {
      const draft = await client.draft({
        to: args.to, ...(args.cc ? { cc: args.cc } : {}), ...(args.bcc ? { bcc: args.bcc } : {}),
        subject: args.subject, body: args.body_markdown, ...(args.reply_to_thread_id ? { threadId: args.reply_to_thread_id } : {}),
      });
      desk.record('email_draft', `Drafted "${args.subject}" to ${args.to.join(', ')}`, draft);
      return { ...draft, sent: false };
    }),
  } satisfies ToolHandler<DraftEmailArgs, unknown, ToolDispatcherContext>,
];
