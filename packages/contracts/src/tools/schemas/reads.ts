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
  date_range: dateRangeSchema.optional(),
  include_declined: z.boolean().default(false),
  limit: z.int().min(1).max(50).default(20),
});
export type QueryCalendarArgs = z.infer<typeof queryCalendarArgsSchema>;

// Connect intent is its own tool, never a side effect of a failed service call: the consent
// URL must be reachable on demand (owner direction 2026-09-24).
export const connectServiceArgsSchema = z.strictObject({
  service: z.enum(['google']),
});
export type ConnectServiceArgs = z.infer<typeof connectServiceArgsSchema>;

export const getCommunicationArgsSchema = z.strictObject({
  date_range: dateRangeSchema.optional(),
});
export type GetCommunicationArgs = z.infer<typeof getCommunicationArgsSchema>;

// 'all' is a read-filter sentinel, not a task state — write-side status vocabulary lives
// with the update_task args.
export const taskStatusFilterSchema = z.enum(['todo', 'in_progress', 'done', 'all']);
export type TaskStatusFilter = z.infer<typeof taskStatusFilterSchema>;

export const getTasksArgsSchema = z.strictObject({
  status: taskStatusFilterSchema.default('todo'),
  limit: z.int().min(1).max(100).default(20),
});
export type GetTasksArgs = z.infer<typeof getTasksArgsSchema>;

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
export const searchEpisodesArgsSchema = z.strictObject({
  query: z.string().min(1).max(500),
  limit: z.int().min(1).max(20).default(5),
  date_range: dateRangeSchema.optional(),
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
  url: z.url().max(2000),
  instruction: z.string().min(1).max(1000),
});
export type BrowsePageArgs = z.infer<typeof browsePageArgsSchema>;

// B-tool-2: bounded in-page actions. observe-before-act seam, capped steps, deterministic
// stop before anything irreversible-looking (submit/pay/send/book...) - those need the
// approval gate, which is B-tool-3, not model judgment.
export const browseActArgsSchema = z.strictObject({
  url: z.url().max(2000),
  task: z.string().min(1).max(1000),
  max_actions: z.int().min(1).max(5).default(3),
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
