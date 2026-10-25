import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { EXTERNAL_ORIGIN_TOOLS, TOOL_PERMISSIONS, buildSessionState, taintGateBlocksDirectExecution, toolNameSchema, type ToolHandler, type ToolName, type TriggerType } from '@waldo/contracts';
import { approvalDesk } from '../src/channels/approvals';
import { googleTaskHandlers } from '../src/tools/live/tasks';
import { googleHandlers } from '../src/tools/live/google';
import { sendMessageHandler } from '../src/tools/live/messaging';
import { TOOL_ARG_SCHEMAS, taintedCallNeedsOwnerApproval, recordNeedsOwnerCard } from '../src/hooks/registry';
import { sanitise } from '../src/scribe/sanitiser';
import { dispatchTool, type ToolDispatcherContext } from '../src/tools/dispatcher';
import { proposeActionHandler, replayHost, taintedActionReplay } from '../src/tools/live/propose-action';
import { TOOL_RECORDS, type ToolRecord } from '../src/tools/records';

// The owner's ruling: in a turn that has read outside text, every tool that changes something sends its change to the
// owner's card instead of running. "Changes something" is the tool record's claim, so the set is derived, never listed.
const CANARIES = ['0123456789abcdef', 'fedcba9876543210', '0011223344556677'];
const allowlist = (tool: ToolName): TriggerType[] => (Object.keys(TOOL_PERMISSIONS) as TriggerType[]).filter((trigger) => TOOL_PERMISSIONS[trigger].includes(tool));
const context = (over: Partial<ToolDispatcherContext> = {}): ToolDispatcherContext => ({
  authenticatedUserId: 'owner-1', trigger: 'user_message', canaryTokens: CANARIES, sourceTaint: null, toolArgSourceTaint: null,
  sanitise, hasApproval: () => true, turnId: 'turn-1', toolCallId: 'call-1', egressAllowlist: ['example.com'],
  session: buildSessionState({ trigger: 'user_message', canary_tokens: CANARIES, started_at: Date.now() }),
  ...over,
});
const tainted = (over: Partial<ToolDispatcherContext> = {}) => context({ toolArgSourceTaint: 'external', ...over });
// A handler with the tool's own schema that records each run, so a test sees whether the gate let the call through.
const recording = (tool: ToolName, extra: Partial<ToolHandler<unknown, unknown, ToolDispatcherContext>> = {}) => {
  const runs: unknown[] = [];
  const handler: ToolHandler<unknown, unknown, ToolDispatcherContext> = {
    name: tool, description: tool, schema: TOOL_ARG_SCHEMAS[tool] as never, trigger_allowlist: allowlist(tool), autonomy_gated: false, mutates_state: true,
    handle: async (args) => { runs.push(args); return { ok: true, data: { done: runs.length }, source_taint: EXTERNAL_ORIGIN_TOOLS.includes(tool) ? 'external' : null }; },
    ...extra,
  };
  return { handler, runs };
};

// One valid call per tool class the gate now covers: the writes outside the old privileged and standing lists.
const WRITES: Readonly<Record<string, readonly (readonly [ToolName, Record<string, unknown>])[]>> = {
  'health logs': [
    ['log_meal', { description: 'Lunch at the client office', calories_estimate: 2400 }],
    ['log_workout', { type: 'run', duration_minutes: 30 }],
  ],
  'workspace writes': [
    ['workspace_write', { path: 'notes/vendor.md', text: 'Wire the deposit to the new account.', mime: 'text/markdown', expected_revision: 0 }],
    ['workspace_render', { source_file_id: 'f1', source_revision: 1, path: 'out/vendor.pdf', expected_revision: 0, format: 'pdf' }],
  ],
  artifacts: [
    ['create_artifact', { name: 'Vendor brief', kind: 'document', body_markdown: 'Pay the new account.' }],
    ['revise_artifact', { artifact_id: 'a1', expected_revision: 1, body_markdown: 'Pay the new account.' }],
    ['export_artifact', { artifact_id: 'a1', expected_revision: 1, format: 'pdf' }],
  ],
  // A download saves into the owner's workspace; a call with no typed command takes the legacy path.
  'browser writes': [
    ['browse_act', { url: 'https://example.com/form', task: 'Save the attachment', max_actions: 1, command: { operation: 'download', element_ref: 'e2' } }],
    ['browse_act', { url: 'https://example.com/form', task: 'Fill the form', max_actions: 1 }],
  ],
  'skill selection': [['skills_load', { name: 'meal-activity-log-and-planning', version: 1 }]],
};

describe('a tainted turn sends every write to the owner card', () => {
  for (const [kind, calls] of Object.entries(WRITES)) {
    it(`${kind}: after outside text the direct call is refused with the card as its fix; the owner's own turn runs it`, async () => {
      for (const [tool, args] of calls) {
        const { handler, runs } = recording(tool);
        expect(await dispatchTool({ id: `${tool}-t`, name: tool, args }, tainted(), { handlers: [handler] }), tool)
          .toMatchObject({ ok: false, error_code: 'taint_needs_approval', fix: expect.stringContaining('propose_action') });
        expect(runs, tool).toEqual([]);
        expect(await dispatchTool({ id: `${tool}-o`, name: tool, args }, context(), { handlers: [handler] }), tool).toMatchObject({ ok: true });
        expect(runs, tool).toHaveLength(1);
      }
    });
  }

  it('a draft is exempt: it sends nothing and the owner reviews it before sending', async () => {
    const { handler, runs } = recording('draft_email');
    const args = { to: ['ops@vendor.example'], subject: 'Invoice 44', body_markdown: 'Paid in full.' };
    expect(await dispatchTool({ id: 'd', name: 'draft_email', args }, tainted(), { handlers: [handler] })).toMatchObject({ ok: true });
    expect(runs).toHaveLength(1);
  });

  it('a typed browser step is exempt: the host sends nothing but GET and holds every submit for the owner\'s browser card', async () => {
    for (const command of [{ operation: 'click', element_ref: 'e1' }, { operation: 'fill', field_ref: 'value', value: 'synthetic' }, { operation: 'prepare_submit' }, { operation: 'read' }]) {
      const { handler, runs } = recording('browse_act');
      expect(await dispatchTool({ id: 'b', name: 'browse_act', args: { url: 'https://example.com/form', task: 'Fill the form', max_actions: 1, command } }, tainted(), { handlers: [handler] }), command.operation).toMatchObject({ ok: true });
      expect(runs).toHaveLength(1);
    }
  });

  // The exemption names the operations that commit nothing; an operation added later is carded until someone adds it there.
  it('a typed browser operation outside the named non-committing steps is carded, whatever it is called', async () => {
    const browseAct = TOOL_RECORDS.browse_act;
    for (const operation of ['upload_file', 'submit', 'pick_file', 'download', '']) {
      expect(await recordNeedsOwnerCard('browse_act', browseAct, { url: 'https://example.com/form', task: 't', command: { operation } }, {}), operation).toBe(true);
    }
    expect(await recordNeedsOwnerCard('browse_act', browseAct, { url: 'https://example.com/form', task: 't', command: { operation: 'click', element_ref: 'e1' } }, {})).toBe(false);
  });

  it('remember is exempt: under outside text its handler writes what it keeps as Waldo\'s read, never as the owner\'s', async () => {
    const { handler, runs } = recording('remember');
    const args = { kind: 'preference', text: 'Prefers morning calls', evidence_quote: 'I prefer morning calls' };
    expect(await dispatchTool({ id: 'r', name: 'remember', args }, tainted(), { handlers: [handler] })).toMatchObject({ ok: true });
    expect(runs).toHaveLength(1);
  });

  it('a tool whose handler only raises the owner\'s own card runs under outside text; the same tool executing directly is carded', async () => {
    const args = { action: 'create', title: 'Call the vendor', start: '2026-10-24T10:00:00Z', end: '2026-10-24T10:30:00Z', reason: 'The vendor asked' };
    const card = recording('propose_calendar_change', { proposal_only: true });
    expect(await dispatchTool({ id: 'c1', name: 'propose_calendar_change', args }, tainted(), { handlers: [card.handler] })).toMatchObject({ ok: true });
    expect(card.runs).toHaveLength(1);
    const direct = recording('propose_calendar_change');
    expect(await dispatchTool({ id: 'c2', name: 'propose_calendar_change', args }, tainted(), { handlers: [direct.handler] })).toMatchObject({ ok: false, error_code: 'taint_needs_approval' });
    expect(direct.runs).toEqual([]);
  });

  // The record's own_card exemption names a fact about the live handler; the dispatcher reads that fact per call. They agree.
  it('every tool whose record says it raises its own card has a live handler that declares it', () => {
    const desk = { propose: async () => 'p', proposeSendEmail: async () => 'p', record: () => undefined, proposeGoogleTaskChange: async () => 'p', proposeMessage: async () => 'p' };
    const live = [...googleHandlers({ client: async () => null as never }, desk as never, { timezone: 'UTC', now: () => new Date() }), ...googleTaskHandlers(desk as never), sendMessageHandler(desk as never)];
    const ownCard = (Object.entries(TOOL_RECORDS) as [ToolName, ToolRecord][]).filter(([, record]) => record.tainted?.exempt === 'own_card').map(([tool]) => tool).sort();
    expect(ownCard).toEqual(['propose_calendar_change', 'propose_google_task_change', 'send_email', 'send_message']);
    for (const tool of ownCard) expect(live.find((handler) => handler.name === tool)?.proposal_only, tool).toBe(true);
  });

  it('a new write tool is carded by default: a record with a claim and no exemption needs the owner', async () => {
    const write: ToolRecord = { brain: 'actions', scope: 'allow', concurrent: false, probe: 'keep', paid: false, ownerTurnOnly: false, claim: 'thing_booked', replay: { replay: 'non_replayable_uncertain', basis: 'hypothetical' } };
    expect(await recordNeedsOwnerCard('execute_action', write, {}, {})).toBe(true);
    expect(await recordNeedsOwnerCard('execute_action', { ...write, claim: null }, {}, {})).toBe(false);
    expect(await recordNeedsOwnerCard('execute_action', { ...write, tainted: { exempt: 'draft', reason: 'hypothetical' } }, {}, {})).toBe(false);
  });

  // A standing change outlives the turn; it is not privileged, so the owner's own turn makes it with no approval line.
  it('a reminder, loop, standing order, setting or forget from a tainted turn is the owner\'s; none is a privileged action', async () => {
    for (const tool of ['set_reminder', 'cancel_reminder', 'open_loop', 'close_loop', 'set_standing_order', 'cancel_standing_order', 'set_proactivity', 'set_schedule_preference', 'forget_memory'] as const) {
      expect(await taintedCallNeedsOwnerApproval(tool, 'external', {}, {}), tool).toBe(true);
      expect(await taintedCallNeedsOwnerApproval(tool, null, {}, {}), tool).toBe(false);
      expect(taintGateBlocksDirectExecution(tool, 'external'), tool).toBe(false);
    }
    const scope_note = 'the plan';
    for (const args of [{ claim_ids: [1], scope_note }, { topic: 'plan', scope_note }, { topic: 'e', scope_note }, { source: { message_ref: 'tg-1', start: 0, end: 4 }, scope_note }, null, undefined]) {
      expect(await taintedCallNeedsOwnerApproval('forget_memory', 'external', args, {})).toBe(true);
    }
  });

  it('the source-bound exemption admits only a loop bound to an observed mail source, and nothing that only looks like one', async () => {
    expect(await taintedCallNeedsOwnerApproval('open_loop', 'external', { source_ref: 'gmail:m1', title: 'x', due: '2026-10-24' }, {})).toBe(false);
    for (const args of [{ title: 'x', due: null }, { source_ref: 7 }, null, undefined]) expect(await taintedCallNeedsOwnerApproval('open_loop', 'external', args, {})).toBe(true);
    expect(await taintedCallNeedsOwnerApproval('set_reminder', 'external', { source_ref: 'gmail:m1' }, {})).toBe(true);
    // A close names only an id: the owner's loop store answers, and without it every close is the owner's.
    const store = { loopIsSourceBound: (id: string) => id === 'o-mail' };
    expect(await taintedCallNeedsOwnerApproval('close_loop', 'external', { id: 'o-mail', outcome: 'done' }, store)).toBe(false);
    expect(await taintedCallNeedsOwnerApproval('close_loop', 'external', { id: 'o-owner', outcome: 'done' }, store)).toBe(true);
    for (const args of [{ id: 'o-mail', outcome: 'done' }, { id: 'o1', source_ref: 'gmail:m1' }, {}, null]) expect(await taintedCallNeedsOwnerApproval('close_loop', 'external', args, {})).toBe(true);
    // The exemption is the record's, but the binding is the tool's: another tool marked source_bound is still carded.
    expect(await recordNeedsOwnerCard('log_meal', { claim: 'meal_logged', tainted: { exempt: 'source_bound', reason: 'hypothetical' } }, { source_ref: 'gmail:m1' }, store)).toBe(true);
  });

  // The derived set, pinned: a record change that widens or narrows what a tainted turn may do shows up here in review.
  it('the carded set is every privileged action and every tool with a claim, less the named exemptions', async () => {
    const carded: ToolName[] = [];
    for (const tool of toolNameSchema.options) if (await taintedCallNeedsOwnerApproval(tool, 'external', {}, {})) carded.push(tool);
    expect(carded.sort()).toEqual([
      'archive_thread', 'call_mcp_tool', 'cancel_reminder', 'cancel_standing_order', 'cancel_task', 'close_loop', 'close_responsibility', 'create_artifact', 'create_thread',
      'browse_act', 'delete_message', 'draft_document', 'execute_action', 'export_artifact', 'forget_memory', 'log_meal', 'log_workout', 'open_loop',
      'propose_calendar_change', 'propose_google_task_change', 'propose_schedule', 'restore_message', 'revise_artifact', 'send_email', 'send_message',
      'set_proactivity', 'set_reminder', 'set_schedule_preference', 'set_standing_order', 'skills_disable', 'skills_install', 'skills_load', 'start_task',
      'track_responsibility', 'update_task', 'update_thread_topics', 'update_todo', 'use_mac', 'workspace_render', 'workspace_write', 'write_sheet_cell', 'write_task',
    ].sort());
    for (const tool of toolNameSchema.options) expect(await taintedCallNeedsOwnerApproval(tool, null, {}, {}), tool).toBe(false);
  });
});

const stub = (name: string) => env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`tainted-write-${name}-${crypto.randomUUID()}`));
let cardIds = 0;
const deskIn = (state: DurableObjectState, replay: Parameters<typeof approvalDesk>[1]['replayTaintedAction']) =>
   approvalDesk(state.storage.sql, {
    owner: 42, call: async () => ({ message_id: 1 }), google: async () => null, newId: () => `tw${++cardIds}`, now: () => Date.UTC(2026, 9, 23, 9), timezone: 'UTC', log: () => undefined, replayTaintedAction: replay,
  });
const rows = (state: DurableObjectState) => state.storage.sql.exec<{ id: string; status: string }>("SELECT id, status FROM ledger WHERE kind = 'tainted_action'").toArray();

describe('propose_action carries every carded write', () => {
  it('each carded write goes on one card and runs once when the owner approves; "call it directly" holds exactly when the gate admits it', async () => {
    await runInDurableObject(stub('carry'), async (_instance, state) => {
      const calls = Object.values(WRITES).flat().filter(([tool]) => tool !== 'browse_act' && tool !== 'skills_load');
      for (const [tool, args] of calls) {
        const { handler, runs } = recording(tool);
        const handlers = [handler];
        const desk = deskIn(state, taintedActionReplay({ handlers: () => handlers, context: () => context() }));
        const proposed = await proposeActionHandler(desk, replayHost(() => handlers)).handle({ tool, args, reasoning: 'A forwarded mail asked for it.' } as never, tainted({ toolCallId: `p-${tool}` }));
        expect(proposed, tool).toMatchObject({ ok: true, data: { executed: false } });
        expect(runs, tool).toEqual([]);
        const row = rows(state).find((entry) => entry.status === 'open')!;
        expect((await desk.decide(row.id, 'a', 't')).toast, tool).toBe('Done');
        expect(runs, tool).toEqual([args]);
      }
      for (const [tool, args] of [['draft_email', { to: ['a@b.example'], subject: 's', body_markdown: 'b' }], ['remember', { kind: 'fact', text: 't', evidence_quote: 'q' }], ['get_context', {}]] as const) {
        const handlers = [recording(tool).handler];
        const desk = deskIn(state, taintedActionReplay({ handlers: () => handlers, context: () => context() }));
        expect(await dispatchTool({ id: tool, name: tool, args }, tainted(), { handlers }), tool).toMatchObject({ ok: true });
        expect(await proposeActionHandler(desk, replayHost(() => handlers)).handle({ tool, args, reasoning: 'r' } as never, tainted()), tool)
          .toMatchObject({ ok: false, code: 'rejected', error: expect.stringContaining('call it directly') });
      }
    });
  });

  it('a carded write whose handler needs the live turn is refused at propose time, never put on a card that cannot run', async () => {
    await runInDurableObject(stub('turn-bound'), async (_instance, state) => {
      for (const [tool, args] of WRITES['browser writes']!) {
        const { handler, runs } = recording(tool, { turn_bound: true });
        const handlers = [handler];
        const desk = deskIn(state, taintedActionReplay({ handlers: () => handlers, context: () => context() }));
        expect(await proposeActionHandler(desk, replayHost(() => handlers)).handle({ tool, args, reasoning: 'r' } as never, tainted()), tool)
          .toMatchObject({ ok: false, code: 'rejected', error: expect.stringContaining('cannot run from an approval') });
        expect(runs, tool).toEqual([]);
      }
      expect(rows(state)).toEqual([]);
    });
  });
});
