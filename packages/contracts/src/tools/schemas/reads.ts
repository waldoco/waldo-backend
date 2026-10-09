import { z } from 'zod';
import { docProviderSchema, docReadResultSchema } from '../../adapters/doc';
import { iso8601Schema } from '../../core/error';
import { hallTypeSchema } from '../../memory/hall';
import { sourceTaintSchema } from '../../memory/sanitise';

// Model-supplied argument shapes for the read-cluster tools (ADR-0008/0021 surface). The
// dispatcher validates args at the PreToolUse Zod gate (ADR-0032) before any handler runs,
// so every bound here is a hard ceiling on what the model can request — strictObject makes
// a smuggled extra argument a parse failure, not a silent pass-through (ADR-0029).

// Instants, not strings: iso8601 admits non-UTC offsets, so lexicographic order can lie.
const isoInstant = iso8601Schema.describe(
  'ISO 8601 datetime with seconds and an explicit UTC offset, e.g. 2026-09-26T00:00:00+05:30',
);
const dateRangeSchema = z
  .strictObject({ from: isoInstant, to: isoInstant })
  .refine((r) => Date.parse(r.from) <= Date.parse(r.to), {
    error: 'date_range must not end before it starts',
    path: ['to'],
  });

export const getCrsArgsSchema = z.strictObject({
  range_days: z.int().min(1).max(90).default(1),
});
export type GetCrsArgs = z.infer<typeof getCrsArgsSchema>;

// Metric selectors are names only — results come back as zones/bands/trends, never raw
// values (ADR-0024 destination rules); the closed set is what the health seam serves.
export const healthMetricSelectorSchema = z.enum([
  'hrv',
  'hr',
  'sleep',
  'spo2',
  'strain',
  'recovery',
]);
export type HealthMetricSelector = z.infer<typeof healthMetricSelectorSchema>;

export const getHealthArgsSchema = z.strictObject({
  metrics: z.array(healthMetricSelectorSchema).optional(),
  date: iso8601Schema.optional(),
});
export type GetHealthArgs = z.infer<typeof getHealthArgsSchema>;

// 'query_calendar' is the ADR-0040 rename of the legacy schedule read.
export const queryCalendarArgsSchema = z.strictObject({
  account: z.email().optional(),
  date_range: dateRangeSchema.optional(),
  calendar_id: z.string().min(1).max(254).default('primary'),
  page_token: z.string().min(1).max(4096).optional(),
  include_declined: z.boolean().default(false),
  limit: z.int().min(1).max(50).default(20),
}).refine(args => !args.page_token || Boolean(args.date_range), {error:'page_token requires the same explicit date_range',path:['date_range']}).refine(args => !args.date_range || Date.parse(args.date_range.from) < Date.parse(args.date_range.to), {error:'Calendar range must advance',path:['date_range']});
export type QueryCalendarArgs = z.infer<typeof queryCalendarArgsSchema>;

// Provider receipt validation is also used after the proxy boundary, before claiming coverage.
export const calendarPageSchema = z.strictObject({
  events: z.array(z.strictObject({
    id:z.string().min(1).max(1024),title:z.string().max(2000),start:z.string().min(1).max(64),end:z.string().min(1).max(64),all_day:z.boolean(),
    location:z.string().max(2000).optional(),description:z.string().max(2000).optional(),attendees:z.int().min(0).optional(),etag:z.string().max(1024).optional(),
    status:z.enum(['confirmed','tentative','cancelled']).optional(),updated:iso8601Schema.optional(),recurring_event_id:z.string().max(1024).optional(),original_start:iso8601Schema.optional(),source_url:z.string().max(2048).optional(),attendee_names:z.array(z.string().max(320)).max(50).optional(),
  }).refine(event => {
    const time = event.all_day ? z.iso.date() : iso8601Schema;
    return time.safeParse(event.start).success && time.safeParse(event.end).success && Date.parse(event.start) < Date.parse(event.end);
  }, 'invalid Calendar event range')).max(50),
  next_page_token:z.string().min(1).max(4096).nullable(), fetched_count:z.int().min(0).max(50),
  account:z.strictObject({connection_id:z.string().min(1).max(1024).nullable(),email:z.string().min(1).max(320).nullable()}),
  observed_at:iso8601Schema,
}).refine(page=>page.fetched_count>=page.events.length,'returned events exceed fetched count');

// Connect intent is its own tool, never a side effect of a failed service call: the consent
// URL must be reachable on demand (owner direction 2026-09-24).
export const connectServiceArgsSchema = z.strictObject({
  service: z.enum(['google']),
});
export type ConnectServiceArgs = z.infer<typeof connectServiceArgsSchema>;

export const getCommunicationArgsSchema = z.strictObject({
  account: z.email().optional(),
  date_range: dateRangeSchema.optional(),
  // A page above 30 messages exceeds the inline tool-output limit and reaches the model as a stored-output pointer, not as mail.
  limit: z.int().min(1).max(30).default(10),
  page_token: z.string().min(1).optional(),
}).refine(args=>!args.page_token||Boolean(args.date_range),{error:'page_token requires the same explicit date_range',path:['date_range']});
export type GetCommunicationArgs = z.infer<typeof getCommunicationArgsSchema>;

// A1 gmail parity: free-text mail search (Gmail q passthrough; the handler appends
// after:/before: from the date range) and a single-thread body read. Both are read-only;
// the E1 verification-artifact quarantine runs on results before they reach model context.
export const searchCommunicationArgsSchema = z.strictObject({
  account: z.email().optional(),
  cursor: z.string().min(1).max(4096).optional(),
  query: z.string().min(1),
  date_range: dateRangeSchema.optional(),
  limit: z.int().min(1).max(20).default(10),
});
export type SearchCommunicationArgs = z.infer<typeof searchCommunicationArgsSchema>;

export const readThreadArgsSchema = z.strictObject({
  account: z.email().optional(),
  cursor: z.string().min(1).max(4096).optional(),
  thread_id: z.string().min(1),
  limit: z.int().min(1).max(20).default(10),
});
export type ReadThreadArgs = z.infer<typeof readThreadArgsSchema>;

// 'all' is a read-filter sentinel, not a task state — write-side status vocabulary lives
// with the update_task args.
export const taskStatusFilterSchema = z.enum(['todo', 'in_progress', 'done', 'all']);
export type TaskStatusFilter = z.infer<typeof taskStatusFilterSchema>;

export const getTasksArgsSchema = z.strictObject({
  account: z.email().optional(),
  status: taskStatusFilterSchema.default('todo'),
  limit: z.int().min(1).max(100).default(20),
});
export type GetTasksArgs = z.infer<typeof getTasksArgsSchema>;

// Drive reads over the REST adapter (explicit, no MCP). The query is a typed field the edge turns into
// a Drive query; the model never writes Drive query syntax. file_id is a closed id shape, not free text.
export const readDriveArgsSchema = z.strictObject({
  account: z.email().optional(),
  action: z.enum(['recent', 'search', 'get', 'content']),
  name_contains: z.string().min(1).max(200).optional(),
  file_id: z.string().regex(/^[A-Za-z0-9_-]{10,128}$/).optional(),
  page_size: z.int().min(1).max(50).default(10),
  page_token: z.string().min(1).max(2048).optional(),
  connection_id: z.string().min(1).max(256).optional(),
  expected_modified_time: z.string().datetime({ offset: true }).optional(),
}).refine((a) => (a.action !== 'search' || a.name_contains !== undefined) && (a.action !== 'get' || a.file_id !== undefined) && (a.action !== 'content' || (a.file_id !== undefined && a.connection_id !== undefined && a.expected_modified_time !== undefined)), { message: 'search needs name_contains; get needs file_id; content needs file_id, connection_id and expected_modified_time from a current metadata read' });
export type ReadDriveArgs = z.infer<typeof readDriveArgsSchema>;

export const getMasterMetricsArgsSchema = z.strictObject({
  date: iso8601Schema.optional(),
});
export type GetMasterMetricsArgs = z.infer<typeof getMasterMetricsArgsSchema>;

export const getContextArgsSchema = z.strictObject({
  topic: z.string().min(1).max(200).optional(),
});
export type GetContextArgs = z.infer<typeof getContextArgsSchema>;

// Reads span all five halls; mutating memory writes live in ./writes.
export const readMemoryArgsSchema = z.strictObject({
  hall: hallTypeSchema.optional(),
  limit: z.int().min(1).max(50).default(10),
  query: z.string().min(1).max(500).optional(),
});
export type ReadMemoryArgs = z.infer<typeof readMemoryArgsSchema>;

// The model-facing bound of the episode FTS5 leg — episodeSearchArgsSchema (memory/episode)
// is the internal gateway shape; this seam additionally caps what the model may request.
// Two distinct modes. Search takes `query` (with optional limit and date_range). Exact-source
// takes `ref`, a value copied from a prior search hit, and returns that stored turn in
// full. The two never mix: a request names exactly one, and date_range is search-only.
// (limit carries a schema default, so it is inert in exact-source mode, not rejected.)
export const searchEpisodesArgsSchema = z
  .strictObject({
    query: z.string().min(1).max(500).optional(),
    ref: z.string().min(1).max(200).optional(),
    limit: z.int().min(1).max(20).default(5),
    date_range: dateRangeSchema.optional(),
  })
  .superRefine((args, ctx) => {
    if ((args.query === undefined) === (args.ref === undefined)) {
      ctx.addIssue({ code: 'custom', message: 'provide exactly one of query or ref', path: ['query'] });
    }
    if (args.ref !== undefined && args.date_range !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'date_range applies to query searches only', path: ['date_range'] });
    }
  });
export type SearchEpisodesArgs = z.infer<typeof searchEpisodesArgsSchema>;

// execute_action runs only a previously proposed-and-confirmed action: the confirmation
// token is the user's approval artifact from the ADR-0018 autonomy gate, never
// model-mintable content.
export const executeActionArgsSchema = z.strictObject({
  action_id: z.string().min(1),
  confirmation_token: z.string().min(1),
});
export type ExecuteActionArgs = z.infer<typeof executeActionArgsSchema>;

// — ADR-0049 general-agent tools — web_search / read_document / call_mcp_tool pull
// untrusted external text into the loop; they co-ship with the taint→privileged-action
// gate and are blocked from execution without it.

export const webSearchArgsSchema = z.strictObject({
  query: z.string().min(1).max(500),
  limit: z.int().min(1).max(10).default(5),
});
export type WebSearchArgs = z.infer<typeof webSearchArgsSchema>;

// B-tool-1: read-only browser. One shot: open the page in a real browser, extract, done.
// No act/observe here - bounded actions are a later slice with the approval gate.
export const browsePageArgsSchema = z.strictObject({
  session_handle: z.string().min(1).max(80).optional().describe('Continue the exact owner browser session returned by a prior observation; never a provider ID.'),
  provider: z.enum(['cloudflare_playwright', 'browserbase_stagehand_http_v3']).optional(),
  url: z.url().max(2000),
  instruction: z.string().min(1).max(1000),
});
export type BrowsePageArgs = z.infer<typeof browsePageArgsSchema>;

// B-tool-2: bounded in-page actions. observe-before-act seam, capped steps, deterministic
// stop before anything irreversible-looking (submit/pay/send/book...) - those need the
// approval gate, which is B-tool-3, not model judgment.
const browserCommandIntent = z.enum(['read', 'send']).optional();
export const browserTaskCommandSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('goto'), url: z.url().max(2000), intent: browserCommandIntent }),
  z.strictObject({ operation: z.literal('click'), element_ref: z.string().min(1).max(80), intent: browserCommandIntent }),
  z.strictObject({ operation: z.literal('type'), element_ref: z.string().min(1).max(80), value: z.string().min(1).max(1000).optional(), key: z.literal('Enter').optional(), intent: browserCommandIntent }).refine(value => (value.value !== undefined) !== (value.key !== undefined), 'Type needs exactly a value or Enter'),
  z.strictObject({ operation: z.literal('select'), element_ref: z.string().min(1).max(80), value: z.string().max(1000), intent: browserCommandIntent }),
  z.strictObject({ operation: z.literal('set_checked'), element_ref: z.string().min(1).max(80), checked: z.boolean(), intent: browserCommandIntent }),
  z.strictObject({ operation: z.literal('scroll'), delta: z.int().min(-2000).max(2000), intent: browserCommandIntent }),
  z.strictObject({ operation: z.literal('read'), intent: browserCommandIntent }),
  z.strictObject({ operation: z.literal('wait'), milliseconds: z.int().min(0).max(1000), intent: browserCommandIntent }),
  z.strictObject({ operation: z.literal('inspect') }),
  z.strictObject({ operation: z.literal('fill'), field_ref: z.string().min(1).max(80), value: z.string().min(1).max(1000) }),
  z.strictObject({ operation: z.literal('prepare_submit') }),
  z.strictObject({ operation: z.literal('verify') }),
  z.strictObject({ operation: z.literal('open_tab'), url: z.url().max(2000) }),
  z.strictObject({ operation: z.literal('switch_tab'), tab_ref: z.string().min(1).max(80) }),
  z.strictObject({ operation: z.literal('close_tab'), tab_ref: z.string().min(1).max(80) }),
  z.strictObject({ operation: z.literal('screenshot') }),
  z.strictObject({ operation: z.literal('cancel') }),
]);
export type BrowserTaskCommand = z.infer<typeof browserTaskCommandSchema>;
export const browseActArgsSchema = z.strictObject({
  provider: z.enum(['cloudflare_playwright', 'browserbase_stagehand_http_v3']).optional(),
  session_handle: z.string().min(1).max(80).optional(),
  url: z.url().max(2000),
  task: z.string().min(1).max(1000),
  max_actions: z.int().min(1).max(5).default(3),
  command: browserTaskCommandSchema.optional(),
});
export type BrowseActArgs = z.infer<typeof browseActArgsSchema>;

// provider imports the single doc-provider owner (adapters/doc) — the R2 scratch space is
// 'r2_scratch' in every schema; a bare 'scratch' literal is drift.
export const readDocumentArgsSchema = z.strictObject({
  doc_id: z.string().min(1),
  provider: docProviderSchema.optional(),
});
export type ReadDocumentArgs = z.infer<typeof readDocumentArgsSchema>;

// Stored large tool outputs (TE3): read ranges on demand instead of inline truncation.
export const readToolOutputArgsSchema = z.strictObject({
  id: z.string().min(1).max(64),
  offset: z.int().min(0).optional(),
  length: z.int().min(1).max(16_000).optional(),
});
export type ReadToolOutputArgs = z.infer<typeof readToolOutputArgsSchema>;

// MCP is a gated bridge, not a bypass around the typed registry: server must clear the
// dispatch-time server allowlist (ADR-0049), whose shape is deliberately unpinned here.
export const callMcpToolArgsSchema = z.strictObject({
  server: z.string().min(1).max(100),
  tool: z.string().min(1).max(100),
  args: z.record(z.string(), z.unknown()),
});
export type CallMcpToolArgs = z.infer<typeof callMcpToolArgsSchema>;

// Results of the three general-agent tools are external-origin by construction, so the
// taint field pins the single owner's (memory/sanitise) non-null arm: an untainted
// web/document/MCP result is unrepresentable, not merely checked (ADR-0049).
const externalTaintSchema = sourceTaintSchema.unwrap();

// Hits mirror the doc-search privacy wall (ADR-0025): title + url + snippet only — page
// content enters model context solely via an explicit read.
export const webSearchHitSchema = z.strictObject({
  title: z.string().min(1),
  url: z.url(),
  snippet: z.string(),
});
export type WebSearchHit = z.infer<typeof webSearchHitSchema>;

export const webSearchResultSchema = z.strictObject({
  hits: z.array(webSearchHitSchema),
  source_taint: externalTaintSchema,
});
export type WebSearchResult = z.infer<typeof webSearchResultSchema>;

// The document body rides the DocAdapter read shape (adapters/doc), stamped tainted.
export const readDocumentResultSchema = z.strictObject({
  ...docReadResultSchema.shape,
  source_taint: externalTaintSchema,
});
export type ReadDocumentResult = z.infer<typeof readDocumentResultSchema>;

// MCP output is opaque provider JSON — z.json() rejects non-serialisable values at the
// seam; content-level trust is the taint gate's job, not this schema's.
export const callMcpToolResultSchema = z.strictObject({
  output: z.json(),
  source_taint: externalTaintSchema,
});
export type CallMcpToolResult = z.infer<typeof callMcpToolResultSchema>;

// Explicit provider availability, not a calendar-event pagination heuristic.
export const queryAvailabilityArgsSchema=z.strictObject({
 account:z.email().optional(),
 date_range:z.strictObject({from:iso8601Schema,to:iso8601Schema}).refine(r=>Date.parse(r.from)<Date.parse(r.to),'range must advance'),
 calendar_ids:z.array(z.string().min(1).max(254)).min(1).max(50).default(['primary']).refine(ids=>new Set(ids).size===ids.length,'duplicate calendar IDs'),
 duration_minutes:z.int().min(1).max(1440),
 work_windows:z.array(z.strictObject({start:iso8601Schema,end:iso8601Schema}).refine(w=>Date.parse(w.start)<Date.parse(w.end),'window must advance')).max(100).default([]),
});
export type QueryAvailabilityArgs=z.infer<typeof queryAvailabilityArgsSchema>;
export const readOwnerContextArgsSchema=z.strictObject({topic:z.string().min(1).max(200),limit:z.int().min(1).max(12).default(8)});
export type ReadOwnerContextArgs=z.infer<typeof readOwnerContextArgsSchema>;
