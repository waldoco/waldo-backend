import { describe, expect, it } from 'vitest';

// Every table the owner Durable Object can create, and what a forget does about it. Test only, no behaviour change.
//  PURGED    purge() clears the owner's text from it, and `proof` names the test file that seeds a marker and checks it (the guard only checks that file mentions the table name: a substring tripwire against renames and deleted tests, not proof that it seeds one).
//  EXEMPT    holds no owner-authored text (ids, hashes, counters, flags, timestamps, codes); `why` says what it holds.
//  KNOWN_GAP may hold owner text and a literal forget does not reach it, or it has not been inspected. No claim is made about it.
//            Unclear goes here. Whether a forget should reach things the owner made on purpose (artifacts, workspace files,
//            standing orders, which stay preserved and are named in the owner message) is an open owner decision, deferred.
//            Loops, background run summaries, reminder notes, goals, memory blocks and inbox, patrol log and the thread topic index now have literal redaction with readback (proof: memory-forget-do-provider.test.ts).
// A table found in src with no row here fails, so the next store is decided deliberately. Layer: SOURCE (reads source text).
type Row = { kind: 'PURGED'; proof: string } | { kind: 'EXEMPT'; why: string } | { kind: 'KNOWN_GAP'; note: string };
const purged = (proof: string): Row => ({ kind: 'PURGED', proof });
const exempt = (why: string): Row => ({ kind: 'EXEMPT', why });
const gap = (note: string): Row => ({ kind: 'KNOWN_GAP', note });
const TEXT_JSON = 'text-bearing JSON or free text; no purge wired, contents not inspected';

const TABLES: Record<string, Row> = {
  // Memory and derived stores
  reminder_notes: purged('memory-forget-do-provider.test.ts'),
  claims: purged('forget-coverage.test.ts'), episodes: purged('forget-coverage.test.ts'),
  memory_backups: purged('forget-coverage.test.ts'), spots: purged('forget-coverage.test.ts'), core_file_revisions: purged('forget-coverage.test.ts'),
  constellation_nodes: purged('forget-coverage.test.ts'), 
  run_candidates: purged('forget-tracer-stores.test.ts'), outbox: purged('forget-tracer-stores.test.ts'), held_candidates: purged('forget-tracer-stores.test.ts'),
  schedule: purged('forget-tracer-stores.test.ts'), update_cards: purged('forget-derived-stores.test.ts'), day_plan: purged('forget-derived-stores.test.ts'),
  claim_holds: exempt('kind, reason code and a fingerprint hash'), forget_barriers: exempt('never holds topic words for new writes (marker and hash only); legacy rows are redacted on load'),
  purge_pending: exempt('claim id and fingerprint hash'), topic_purge_pending: exempt('fingerprint hash, a marker and a time'), settle_pending: exempt('trace id and time'),
  claim_recall_ready: exempt('claim ids'),
  cost_ledger: exempt('day, call kind, responsibility id, trigger enum, model name, token counts and cost; no owner text'),
  schedule_preferences: exempt('a scheduled-behavior kind enum and an on/off flag; no owner text'),
  owner_request_last: exempt('trace id, time, ok flag and step count of the last owner request; no owner text (hop notes stay in trace_log)'),
  owner_source_scope: exempt('an enum value (none or pasted_only) and a time; no owner text'),
  owner_task_source_scope: exempt('owner/task ids, revision, source-family enums, readiness, bounded nonce/expiry confirmation and host input reference; no owner instruction, fact or forgotten spans'),
  // Per-device transport custody contains no owner-authored text or full heartbeat payloads.
  nonces: exempt('per-device random replay nonces and expiry times; revoke removes the isolated device store'),
  meta: exempt('per-device schema version, socket generation, heartbeat time and revoke fence'),
  commands: gap('per-device owner-requested notification wire text until result/expiry/cancellation; isolated device custody, literal owner forget does not reach it; revoke clears storage after replay horizon'),
  notify_issues: exempt('per-device notification identifiers and issuance times only'),
  // Per iMessage bridge/account custody (IMessageBridgeDO). nonces/meta rows above also cover its replay nonces and bridge meta (ids, generation, cursor, heartbeat, capability report, quarantine reason).
  events: gap('per-bridge inbound event identity and raw digest; the message body is dropped once handed/acknowledged, but held events (media, revoked scope) keep their text as evidence; a literal owner forget does not reach this isolated custody'),
  deliveries: gap('per-bridge frozen reply command bytes (reply text) and result until revoke/retention policy; isolated custody, literal owner forget does not reach it'),
  result_conflicts: exempt('later conflicting host result envelopes: ids, message GUID, state and reason codes; no owner-authored text'),
  sent_messages: exempt('message GUID, command id and result state for receipt correlation'),
  frames: exempt('per-device logical fingerprints, protocol type, identifiers and time; no full frame or answer text'),
  // Operational: counters, flags, hashes, leases, ids, times
  class_state: exempt('counts and times per push class'), daily_push_budget: exempt('counts per day'), event_cooldowns: exempt('event id and time'),
  exempt_telemetry: exempt('counts'), subkind_state: exempt('counts and times'), loop_kill_flags: exempt('flag keys'), loop_progress: exempt('counts'),
  loop_progress_params: exempt('parameter hashes'), loop_observations: exempt('tool name and hashes'),
  local_ingress_rate: exempt('rate buckets'), responsibility_ingress_rate: exempt('rate buckets'), owner_roots: exempt('root key and owner id'),
  common_message_custody: gap('retained authority metadata: owner/presence IDs and digest derived from directory, subject (including WhatsApp phone), locator and revision; no message text, but personal-derived identity retention across content-forget is not a justified unqualified exemption; routing authority is not erased by this inventory'),
  execution_workunit_down_guard: exempt('temporary rollback guard containing only an allowed integer; dropped in the same migration'),
  execution_continuation_down_guard: exempt('temporary rollback guard containing only an allowed integer; dropped in the same migration'),
  owner_event_state: exempt('cursor'), presence_registrations: exempt('ids and state'), presence_sessions: exempt('session ids and times'),
  planning_execution_leases: exempt('lease ids, fences and times'), execution_writer_rollback_guard: exempt('a flag'),
  judgment_authority_rollback_guard: exempt('a flag'), runtime_invocation_v2_scribe_audit: exempt('run id and version'),
  runtime_run_scribe_audit: exempt('run id and version'), probe_state: exempt('a tick counter'), workspace_upload_lease: exempt('lease token, expiry and byte count'),
  card_pins: exempt('card id and time'), heartbeat_notified: exempt('loop id and times'), artifact_exports: exempt('ids, format, size and time'),
  event_briefs: exempt('event id and times'), schedule_runs: exempt('ids, status codes and times'),
  observed_mail: exempt('provider source/thread/message IDs, update-card row pointer, observation time and judged/attached flags; no sender/subject/snippet/body; unattached pointers expire after seven days'),
  loop_mail_sources: exempt('loop/source/message IDs, due/timezone, fixed delivery-state code and revisit time; source-derived title lives in loops and source text in update_cards'),
  // Text the owner made or the runtime stored, not reached by a literal forget
  loop_governor_runs: gap('has a reason TEXT column; its writer was not traced'),
  artifacts: gap('name in the table, body in R2; owner-made'), owner_files: gap('file name and caption; owner-made'),
  standing_orders: gap('trigger and escalation text; owner-made instructions stay preserved and a topic present keeps a forget incomplete (named in the owner message)'), loops: purged('memory-forget-do-provider.test.ts'), background_runs: purged('memory-forget-do-provider.test.ts'),
  ledger: gap('summary and payload JSON'), event_admissions: gap('delivery body'), trace_log: gap('note column; trace sinks not verified'), journal: gap('run journal; only a partial reference in purge, not shown covered'),
  claim_recall: gap('FTS index kept in step with claims by triggers (content=claims); no test checks the index for a marker after a purge'),
  constellation_edges: gap('ids plus a relation label; node removal drops its edges per purge comments, no test checks edges'),
  responsibilities: gap('title, intent and closing evidence text; a literal forget does not reach it yet'), responsibility_items: gap('step title and worker result text; a literal forget does not reach it yet'),
  proactivity: gap('settings JSON, not inspected'), watch_state: gap('key and value, not inspected'), proxy_intent_routes: gap('purpose text, not inspected'), workspace_manifest: gap('state JSON with file names'),
  runtime_runs: gap(TEXT_JSON), runtime_invocation_v2: gap(TEXT_JSON), runtime_journal: gap(TEXT_JSON), runtime_trace: gap(TEXT_JSON),
  // Product-schema tables (do-schema.ts), none wired to purge
  memory_blocks: purged('memory-forget-do-provider.test.ts'), memory_inbox: purged('memory-forget-do-provider.test.ts'), patrol_log: purged('memory-forget-do-provider.test.ts'), interventions: gap(TEXT_JSON), adjustments: gap(TEXT_JSON),
  skills: gap(TEXT_JSON), sheet_commits: gap(TEXT_JSON), thread_topic_index: purged('memory-forget-do-provider.test.ts'), drafts: gap(TEXT_JSON), goals: purged('memory-forget-do-provider.test.ts'),
  outcomes: gap(TEXT_JSON), missions: gap(TEXT_JSON), work_units: gap(TEXT_JSON), owner_domain_events: gap(TEXT_JSON), responsibility_commands: gap(TEXT_JSON),
  responsibility_projection: gap(TEXT_JSON), responsibility_projection_state: gap(TEXT_JSON), planning_execution_requests: gap(TEXT_JSON),
  planning_agent_sessions: gap(TEXT_JSON), planning_provider_invocations: gap(TEXT_JSON), execution_attempts: gap(TEXT_JSON), execution_observations: gap(TEXT_JSON),
  execution_reconciliations: gap(TEXT_JSON), work_unit_candidate_plans: gap(TEXT_JSON), work_unit_planning_commands: gap(TEXT_JSON), work_unit_planning_controls: gap(TEXT_JSON),
  work_unit_planning_projection: gap(TEXT_JSON), judgment_requests: gap(TEXT_JSON), judgment_decisions: gap(TEXT_JSON), authority_grants: gap(TEXT_JSON),
  judgment_commands: gap(TEXT_JSON), judgment_projection: gap(TEXT_JSON), judgment_projection_state: gap(TEXT_JSON),
};

// Vite replaces a literal import.meta.glob call at build time; this package carries no vite client types, hence the directives.
// @ts-expect-error vite-only API
const sources: Record<string, string> = import.meta.glob('../src/**/*.ts', { query: '?raw', import: 'default', eager: true });
// @ts-expect-error vite-only API
const tests: Record<string, string> = import.meta.glob(['./forget*.test.ts', './memory-forget*.test.ts'], { query: '?raw', import: 'default', eager: true });
const created = new Set<string>();
for (const text of Object.values(sources)) for (const m of text.matchAll(/CREATE (?:VIRTUAL )?TABLE (?:IF NOT EXISTS )?([a-z][a-z0-9_]*)/g)) if (!m[1]!.endsWith('_next')) created.add(m[1]!);
// The shared manifests list substrate tables that are created through the same statements.
const manifest = new Set<string>();
for (const list of ['DO_PRODUCT_TABLES', 'DO_RUNTIME_SUBSTRATE_TABLES']) {
  const block = new RegExp(`export const ${list} = \\[([^\\]]*)\\]`).exec(sources['../src/do-schema.ts'] ?? '')?.[1] ?? '';
  for (const m of block.matchAll(/'([a-z0-9_]+)'/g)) manifest.add(m[1]!);
}

describe('forget store table', () => {
  it('has a row for every table the owner DO source creates, and no row for a table that no longer exists', () => {
    expect(created.size).toBeGreaterThan(60);
    expect([...created].filter((name) => !(name in TABLES)).sort()).toEqual([]);
    expect(Object.keys(TABLES).filter((name) => !created.has(name)).sort()).toEqual([]);
  });
  it('has a row for every table in the shared schema manifests', () => {
    expect(manifest.size).toBeGreaterThan(40);
    expect([...manifest].filter((name) => !(name in TABLES)).sort()).toEqual([]);
  });
  it('every PURGED row names a test that exists and mentions the table', () => {
    for (const [name, row] of Object.entries(TABLES)) {
      if (row.kind !== 'PURGED') continue;
      const file = Object.entries(tests).find(([path]) => path.endsWith(`/${row.proof}`));
      expect(file, `${name}: proof ${row.proof}`).toBeDefined();
      expect(file![1], `${name} in ${row.proof}`).toContain(name === 'claim_recall' ? 'claim_recall' : name);
    }
  });
  it('reports the counts, so the open gaps stay visible', () => {
    const counts = { PURGED: 0, EXEMPT: 0, KNOWN_GAP: 0 };
    for (const row of Object.values(TABLES)) counts[row.kind]++;
    console.log('FORGET_STORE_TABLE ' + JSON.stringify({ ...counts, gaps: Object.entries(TABLES).filter(([, row]) => row.kind === 'KNOWN_GAP').map(([name]) => name) }));
    expect(counts.PURGED + counts.EXEMPT + counts.KNOWN_GAP).toBe(Object.keys(TABLES).length);
  });
});
