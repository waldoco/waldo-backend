import { beforeEach, expect, it, vi } from 'vitest';
import { acceptTrustedInvocation, browsePageArgsSchema, workspaceWriteArgsSchema, getHealthArgsSchema, healthSampleSchema, triggerTypeSchema, TOOL_PERMISSIONS } from '@waldo/contracts';
import { createOwnerTurnContext } from '../src/context-composer/owner-turn';
import { createHealthProduction } from '../src/health/production';
import { createOwnerHealthTurnSources } from '../src/health/model-context';
import { healthReadingsHandler } from '../src/health/model-tools';
import { markProtectedHealthRead } from '../src/health/tool-custody';
import { sha256Prefixed } from '../src/context-composer/canonical';
import type { OwnerMessageAdmission } from '../src/identity/owner-message-admission';
const observed = vi.hoisted(() => ({ requests: [] as unknown[], outputs: [] as unknown[][], reply: 'Ready.', replies: [] as string[], afterCall: undefined as (() => void) | undefined }));
vi.mock('openai', () => ({ default: class { responses = { create: async (body: unknown) => {
  observed.requests.push(body);
  observed.afterCall?.();
  return { id: 'fixture', output_text: observed.replies.shift() ?? observed.reply, output: observed.outputs.shift() ?? [], usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } };
} }; } }));
const { createOwnerResponder } = await import('../src/channels/owner-turn');
const memory = { incompleteTopics: () => [], pendingTopics: () => [], claims: () => [], allClaims: () => [], recall: () => [], nodes: () => [], edges: () => [], barriers: () => [], beginSettle: () => {}, endSettle: () => {}, settle: () => {}, sweepInterruptedSettles: () => 0 };
const ledger = { recent: async () => [{ text: 'Account personal@example.test; observed message mail-17: dinner booking remains pending.', source: { source_key: 'mail-17', source_kind: 'tool_result' as const, scope: 'invocation' as const, source_taint: 'external' as const, produced_at: 1 } }], record: async () => {} };
const admitted = async (text: string, ownerHex = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', assertCurrent: () => Promise<void> = async () => {}): Promise<OwnerMessageAdmission> => {
  const digest = await sha256Prefixed(text);
  const accepted = acceptTrustedInvocation({ admission_source: 'authenticated_ingress',
    verified_authority: { principal_ref: `prn_${ownerHex}`, tenant_ref: `ten_${ownerHex}`, verification_ref: 'ver_cccccccccccccccccccccccccccccccc' },
    input_refs: [{ input_ref: 'inp_dddddddddddddddddddddddddddddddd', content_digest: digest }], intent: { kind: 'respond_to_user' },
    occurrence: { occurrence_ref: 'occ_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', occurred_at: 1 }, idempotency_ref: 'idem_ffffffffffffffffffffffffffffffff', accepted_at: 2 });
  if (!accepted.ok) throw new Error('test admission rejected');
  return { invocation: accepted.value, snapshot: { snapshot_ref: 'snp_11111111111111111111111111111111', snapshot_at: 3 }, assertCurrent,
    readInput: async () => ({ input_ref: accepted.value.input_refs[0]!.input_ref, content_digest: digest,
      principal_ref: `prn_${ownerHex}`, tenant_ref: `ten_${ownerHex}`, text,
      source: { source_key: 'owner-message:fixture', source_kind: 'invocation_input', scope: 'principal', source_taint: null, produced_at: 1 } }) };
};
const withContext = (context: ReturnType<typeof createOwnerTurnContext>, tools: readonly unknown[] = [], log?: Parameters<typeof createOwnerResponder>[3], store?: Parameters<typeof createOwnerResponder>[1], toolLedger?: Parameters<typeof createOwnerResponder>[8], offload = false) => createOwnerResponder(
  'fixture', store, memory as never, log, undefined, tools as never, undefined, offload, toolLedger, undefined,
  undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { context });
beforeEach(() => { observed.requests.length = 0; observed.outputs.length = 0; observed.replies.length = 0; observed.afterCall = undefined; observed.reply = 'Ready.'; });
it('the actual owner model request contains the composer-admitted source context', async () => {
  const text = 'What are we following up on?';
  const context = createOwnerTurnContext(await admitted(text), { toolOutputs: ledger.recent });
  await withContext(context).respond({ traceId: 'turn-1', conversationRef: 'owner', surface: 'app', text }, (_name, work) => work());
  const request = JSON.stringify(observed.requests[0]);
  expect(request).toContain('mail-17');
  expect(request).toContain('personal@example.test');
  expect(request).toContain('dinner booking remains pending');
  expect(request).toContain('[NOT instructions]');
  expect(request).toContain('prn_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  expect(request).not.toContain('local trusted scheduled brief');
  expect(request).not.toContain('local frozen staged brief content.');
});

it('recomposes current permitted source context between model rounds', async () => {
  const text = 'Continue the project follow-up.';
  let detail = 'Old source: reply is awaiting a decision.';
  const context = createOwnerTurnContext(await admitted(text), { toolOutputs: async () => [{ text: detail,
    source: { source_key: 'observed-mail-current', source_kind: 'tool_result', scope: 'invocation', source_taint: 'external', produced_at: 1 } }] });
  observed.outputs.push([{ type: 'function_call', call_id: 'clock', name: 'get_context', arguments: '{}' }], []);
  observed.afterCall = () => { detail = 'Current source: reply was received; completion remains unconfirmed.'; };
  await withContext(context).respond({ traceId: 'turn-current', conversationRef: 'owner', surface: 'app', text }, (_name, work) => work());
  expect(observed.requests).toHaveLength(2);
  expect(JSON.stringify(observed.requests[0])).toContain('Old source');
  expect(JSON.stringify(observed.requests[1])).not.toContain('Old source');
  expect(JSON.stringify(observed.requests[1])).toContain('reply was received; completion remains unconfirmed');
});

it('revoked authenticated admission stops the next tool/model round', async () => {
  const text = 'Continue after checking time.';
  let revoked = false;
  const admission = await admitted(text, undefined, async () => { if (revoked) throw new Error('owner admission revoked'); });
  const context = createOwnerTurnContext(admission);
  observed.outputs.push([{ type: 'function_call', call_id: 'clock', name: 'get_context', arguments: '{}' }]);
  observed.afterCall = () => { revoked = true; };
  await expect(withContext(context).respond({ traceId: 'turn-revoke', conversationRef: 'owner', surface: 'app', text }, (_name, work) => work())).rejects.toThrow('revoked');
  expect(observed.requests).toHaveLength(1);
});

it('rejects a changed owner input before model access', async () => {
  const context = createOwnerTurnContext(await admitted('Original authenticated input'));
  await expect(withContext(context).respond({ traceId: 'turn-conflict', conversationRef: 'owner', surface: 'app', text: 'Substituted input' }, (_name, work) => work())).rejects.toThrow('context source rejected');
  expect(observed.requests).toHaveLength(0);
});

it('a revoke after completion preflight blocks every actual provider dispatch and fallback', async () => {
  const text = 'Continue the request.'; let revoked = false;
  const context = createOwnerTurnContext(await admitted(text), { assertSourceCurrent: async () => { if (revoked) throw new Error('source consent revoked'); } });
  const log: Parameters<typeof createOwnerResponder>[3] = event => { if (event.hop === 'complete_phase' && event.detail === 'reply:enter') revoked = true; };
  await expect(withContext(context, [], log).respond({ traceId: 'late-revoke', conversationRef: 'owner', surface: 'app', text }, (_name, work) => work())).rejects.toThrow('revoked');
  expect(observed.requests).toHaveLength(0);
});

it('an unrelated child receives its bounded task and no inherited owner source body', async () => {
  const text = 'Delegate a public lookup.';
  const context = createOwnerTurnContext(await admitted(text), { toolOutputs: async () => [{ text: 'Private source body: PROJECT-COBALT-SECRET',
    source: { source_key: 'observed-private-mail', source_kind: 'tool_result', scope: 'invocation', source_taint: 'external', produced_at: 1 } }] });
  observed.outputs.push([{ type: 'function_call', call_id: 'delegate', name: 'delegate_task', arguments: '{"task":"Look up public weather terminology"}' }], [], []);
  await withContext(context).respond({ traceId: 'turn-child', conversationRef: 'owner', surface: 'app', text }, (_name, work) => work());
  expect(observed.requests).toHaveLength(3);
  expect(JSON.stringify(observed.requests[0])).toContain('PROJECT-COBALT-SECRET');
  expect(JSON.stringify(observed.requests[1])).toContain('public weather terminology');
  expect(JSON.stringify(observed.requests[1])).not.toContain('PROJECT-COBALT-SECRET');
});

it('uses the admitted owner identity and complete permitted input and source context', async () => {
  const text = 'Read my launch context. ' + 'Owner detail. '.repeat(220);
  const mail = 'Account work@example.test; thread mail-long; source body: ' + 'Project context. '.repeat(220) + 'Final source detail: milestone is Friday.';
  const context = createOwnerTurnContext(await admitted(text), { toolOutputs: async () => [{ text: mail,
    source: { source_key: 'observed-mail-long', source_kind: 'tool_result', scope: 'invocation', source_taint: 'external', produced_at: 1 } }] });
  await withContext(context).respond({ traceId: 'turn-long', conversationRef: 'owner-work', surface: 'app', text }, (_name, work) => work());
  const request = JSON.stringify(observed.requests[0]);
  expect(request).toContain('prn_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  expect(request).not.toContain('prn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  expect(request).not.toContain('local trusted scheduled brief');
  expect(request).toContain('milestone is Friday');
  expect(request).toContain('work@example.test');
});

it('resuming main after a side thread restores the main ancestor path across restart', async () => {
  const text = 'Continue the main plan.', context = createOwnerTurnContext(await admitted(text));
  const principal = context.invocation.verified_authority.principal_ref, main = context.conversationRef;
  const first = { id: 'main-before', ownerId: principal, chatId: main, parentId: null, threadAnchorId: null, surface: 'telegram', role: 'user' as const,
    inputOrigin: 'owner' as const, modelPayload: 'Main plan is PROJECT-CANONICAL', appPayload: 'Main plan is PROJECT-CANONICAL', modelProjection: { mode: 'include' as const } };
  const reply = { ...first, id: 'main-before-reply', role: 'assistant' as const, parentId: first.id, inputOrigin: undefined, modelPayload: 'The main plan is ready.', appPayload: 'The main plan is ready.' };
  const side = { ...first, id: 'side-last', chatId: `${main}:thread:isolated`, modelPayload: 'SIDE-CONTENT-PRIVATE', appPayload: 'SIDE-CONTENT-PRIVATE' };
  const store = { load: async () => ({ entries: [first, reply, side], leafId: side.id }), save: async () => {} };
  await withContext(context, [], undefined, store).respond({ traceId: 'main-after', conversationRef: 'owner', surface: 'app', text }, (_name, work) => work());
  const request = JSON.stringify(observed.requests[0]);
  expect(request).toContain('Main plan is PROJECT-CANONICAL');
  expect(request).not.toContain('SIDE-CONTENT-PRIVATE');
});

it('volatile owner health reaches the actual model without prompt/tool trace or ledger payload retention', async () => {
  const text = 'Use my current Recovery context.';
  const context = createOwnerTurnContext(await admitted(text), { workspace: async () => [{ text: 'Synthetic current owner reading HRV-VOLATILE-44 ms; observed today.',
    source: { source_key: 'health:apple:2026-10-10:1:1', source_kind: 'derived_health_view', scope: 'principal', source_taint: null, produced_at: 1 } }] });
  const logs: unknown[] = [], recorded: unknown[] = [];
  const toolLedger = { recent: async () => [], record: async (value: unknown) => { recorded.push(value); } };
  observed.outputs.push([{ type: 'function_call', call_id: 'clock', name: 'get_context', arguments: '{}' }], []);
  await withContext(context, [], value => { logs.push(value); }, undefined, toolLedger as never)
    .respondReceipt({ traceId: 'volatile-health', conversationRef: 'owner', surface: 'app', text }, (_name, work) => work());
  expect(JSON.stringify(observed.requests)).toContain('HRV-VOLATILE-44');
  expect(JSON.stringify(logs)).not.toContain('HRV-VOLATILE-44');
  expect(logs.filter(value => (value as { hop: string }).hop.startsWith('llm_') || (value as { hop: string }).hop.startsWith('tool_'))).not.toHaveLength(0);
  expect(logs.every(value => !('text' in (value as object)))).toBe(true);
  expect(recorded).toEqual([]);
});


it('returns a typed protected owner reply and never saves its numeric text or replays it', async () => {
  const text = 'Use current health context to plan my morning.';
  let includeHealth = true, revoked = false;
  const context = createOwnerTurnContext(await admitted(text), {
    assertSourceCurrent: async () => { if (revoked) throw new Error('health consent withdrawn'); },
    workspace: async () => includeHealth ? [{ text: 'Synthetic owner sleep 420 minutes.',
      source: { source_key: 'health:apple:2026-10-10:1:1', source_kind: 'derived_health_view', scope: 'principal', source_taint: null, produced_at: 1 } }] : [],
  });
  const saved: unknown[] = [], logs: unknown[] = [];
  const store = { load: async () => ({ entries: [], leafId: null }), save: async (entries: unknown) => { saved.push(entries); } };
  const responder = withContext(context, [], entry => { logs.push(entry); }, store);
  observed.reply = 'Your synthetic sleep was 420 minutes. Put the immovable meeting first, then a recovery break.';
  const reply = await responder.respondReceipt({ traceId: 'protected-reply', conversationRef: 'owner', surface: 'app', text }, (_name, work) => work());
  expect(reply.text).toContain('420 minutes');
  expect(reply.custody.kind).toBe('volatile_owner_health');
  expect(JSON.stringify(saved)).not.toContain('420 minutes');
  expect(JSON.stringify(logs)).not.toContain('420 minutes');
  if (reply.custody.kind !== 'volatile_owner_health') throw new Error('protected receipt missing');
  await expect(reply.custody.assertCurrent()).resolves.toBeUndefined();
  includeHealth = false; observed.reply = 'Ready.';
  await responder.respond({ traceId: 'after-protected', conversationRef: 'owner', surface: 'app', text }, (_name, work) => work());
  expect(JSON.stringify(observed.requests.at(-1))).not.toContain('420 minutes');
  revoked = true;
  await expect(reply.custody.assertCurrent()).rejects.toThrow('withdrawn');
});


it('protected model arguments cannot leak to browser jobs, files, memory or third-party handlers', async () => {
  const text = 'Plan around current health context.';
  const context = createOwnerTurnContext(await admitted(text), { workspace: async () => [{ text: 'Synthetic owner physiology 420 minutes.',
    source: { source_key: 'health:apple:2026-10-10:1:1', source_kind: 'derived_health_view', scope: 'principal', source_taint: null, produced_at: 1 } }] });
  const browser = vi.fn(async () => ({ ok: true, data: {}, source_taint: 'external' as const }));
  const file = vi.fn(async () => ({ ok: true, data: {}, source_taint: null }));
  const handlers = [
    { name: 'browse_page', description: 'Browser', schema: browsePageArgsSchema, trigger_allowlist: ['user_message'], autonomy_gated: false, handle: browser },
    { name: 'workspace_write', description: 'File', schema: workspaceWriteArgsSchema, trigger_allowlist: ['user_message'], autonomy_gated: false, mutates_state: true, handle: file },
  ];
  observed.outputs.push([
    { type: 'function_call', call_id: 'browser', name: 'browse_page', arguments: JSON.stringify({ url: 'https://example.test', instruction: 'Synthetic owner physiology 420 minutes.' }) },
    { type: 'function_call', call_id: 'file', name: 'workspace_write', arguments: JSON.stringify({ path: 'health.txt', text: 'Synthetic owner physiology 420 minutes.', mime: 'text/plain', expected_revision: 0 }) },
  ], []);
  const reply = await withContext(context, handlers).respondReceipt({ traceId: 'health-sinks', conversationRef: 'owner', surface: 'app', text }, (_name, work) => work());
  expect(reply.custody.kind).toBe('volatile_owner_health');
  expect(browser).not.toHaveBeenCalled(); expect(file).not.toHaveBeenCalled();
  expect(JSON.stringify(observed.requests.at(-1))).toContain('protected health context');
});

const healthReadyContext = async (text: string, onCall?: (operation: string) => void) => {
  const now = new Date('2026-10-10T12:00:00Z');
  const sample = { sample_id: 'fixture', revision: 1, metric: 'sleep_duration', unit: 'minutes', value: 420, day: '2026-10-10', start_at: '2026-10-10T00:00:00Z', end_at: '2026-10-10T07:00:00Z' };
  const consents = ['storage_compute', 'model_processing'].map(purpose => ({ consent_class: 'health_processing', source: 'apple', purpose, version: 1, status: 'granted', epoch: 1, granted_at: '2026-10-09T07:00:00Z', withdrawn_at: null, deletion_state: 'not_required' }));
  const service = createHealthProduction(async (_fn, _message, args) => {
    onCall?.(String(args.p_operation));
    return args.p_operation === 'consents' ? { consents } : args.p_operation === 'today' ? { source: 'apple', consent_epoch: 1, timezone: 'UTC', compiled_at: '2026-10-10T07:00:00Z', day: '2026-10-10', samples: [sample], aggregates: [] } : { source: 'apple', consent_epoch: 1, samples: [sample], count: 1, has_more: false };
  }, 'canonical-app-owner', { now: () => now });
  const sources = createOwnerHealthTurnSources(service, { now: () => now });
  return createOwnerTurnContext(await admitted(text)).withOwnerHealthSources(sources.read, sources.assertCurrent, [healthReadingsHandler(sources)]);
};
it('an app-only owner with health enabled can use a general tool without admitting health', async () => {
  const text = 'Save my meeting agenda.'; const operations: string[] = [];
  const context = await healthReadyContext(text, operation => operations.push(operation));
  const file = vi.fn(async () => ({ ok: true, data: { saved: true }, source_taint: null }));
  observed.outputs.push([{ type: 'function_call', call_id: 'save', name: 'workspace_write', arguments: JSON.stringify({ path: 'agenda.txt', text: 'Meeting agenda', mime: 'text/plain', expected_revision: 0 }) }], []);
  const response = await withContext(context, [{ name: 'workspace_write', description: 'File', schema: workspaceWriteArgsSchema, trigger_allowlist: ['user_message'], autonomy_gated: false, mutates_state: true, handle: file }]).respondReceipt({ traceId: 'health-enabled-general', conversationRef: 'owner', surface: 'app', text }, (_name, work) => work());
  expect(response.custody.kind).toBe('durable'); expect(file).toHaveBeenCalledOnce(); expect(operations).toEqual([]);
  expect(JSON.stringify(observed.requests)).not.toContain('420');
});
it('private health judgment produces a fresh useful general phase without raw replay or retention', async () => {
  const text = 'Use my current health to prepare a lighter day agenda.';
  const context = await healthReadyContext(text);
  const file = vi.fn(async () => ({ ok: true, data: { saved: true }, source_taint: null }));
  const logs: unknown[] = [], saved: unknown[] = [];
  const projection = { continue_owner_task: true, day_load: 'lighter', spacing: 'more_breaks', exercise: 'gentler', sleep: 'protect', meals: 'regular' };
  observed.outputs.push([{ type: 'function_call', call_id: 'health', name: 'get_health', arguments: '{}' }], [], [], [{ type: 'function_call', call_id: 'save', name: 'workspace_write', arguments: JSON.stringify({ path: 'agenda.txt', text: 'Agenda: morning focus, regular breaks, early finish.', mime: 'text/plain', expected_revision: 0 }) }], []);
  observed.replies.push('', 'Observed sleep: 420 minutes.', JSON.stringify(projection), '', 'Saved your agenda.');
  const response = await withContext(context, [{ name: 'workspace_write', description: 'File', schema: workspaceWriteArgsSchema, trigger_allowlist: ['user_message'], autonomy_gated: false, mutates_state: true, handle: file }], entry => logs.push(entry), { load: async () => ({ entries: [], leafId: null }), save: async entries => { saved.push(entries); } }).respondReceipt({ traceId: 'health-aware-agenda', conversationRef: 'owner', surface: 'app', text }, (_name, work) => work());
  expect(response.text).toContain('420'); expect(response.text).toContain('Saved your agenda'); expect(response.custody.kind).toBe('volatile_owner_health');
  expect(file).toHaveBeenCalledOnce();
  expect(JSON.stringify(observed.requests[1])).toContain('420'); expect(JSON.stringify(observed.requests[2])).toContain('420');
  for (const request of observed.requests.slice(3)) { expect(JSON.stringify(request)).not.toContain('420'); expect(JSON.stringify(request)).not.toContain('private_health_reply'); expect(JSON.stringify(request)).not.toContain('call_id":"health'); }
  expect(JSON.stringify(logs.map(row => (row as { text?: unknown }).text))).not.toContain('420'); expect(JSON.stringify(saved)).not.toContain('420');
});
it('a malformed projection cannot smuggle physiology into a public phase', async () => {
  const text = 'Prepare my day using current health.'; const context = await healthReadyContext(text);
  const file = vi.fn(async () => ({ ok: true, data: {}, source_taint: null }));
  observed.outputs.push([{ type: 'function_call', call_id: 'health', name: 'get_health', arguments: '{}' }], [], []);
  observed.replies.push('', 'Observed sleep: 420 minutes.', JSON.stringify({ continue_owner_task: true, rationale: '420 minutes' }));
  const reply = await withContext(context, [{ name: 'workspace_write', description: 'File', schema: workspaceWriteArgsSchema, trigger_allowlist: ['user_message'], autonomy_gated: false, handle: file }]).respondReceipt({ traceId: 'invalid-projection', conversationRef: 'owner', surface: 'app', text }, (_name, work) => work());
  expect(reply.text).toContain('420'); expect(file).not.toHaveBeenCalled(); expect(observed.requests).toHaveLength(3);
});

it('withdrawal after projection stops the fresh effect and exposes only a fixed failure', async () => {
  const text = 'Prepare a lighter agenda using my current health.'; let revoked = false;
  const context = await healthReadyContext(text, () => { if (revoked) throw new Error('Private health exception 420'); });
  const file = vi.fn(async () => ({ ok: true, data: {}, source_taint: null })); const logs: unknown[] = [];
  observed.outputs.push([{ type: 'function_call', call_id: 'health', name: 'get_health', arguments: '{}' }], [], []);
  observed.replies.push('', 'Observed sleep: 420 minutes.', JSON.stringify({ continue_owner_task: true, day_load: 'lighter', spacing: 'more_breaks', exercise: 'gentler', sleep: 'protect', meals: 'regular' }));
  observed.afterCall = () => { if (observed.requests.length === 3) revoked = true; };
  await expect(withContext(context, [{ name: 'workspace_write', description: 'File', schema: workspaceWriteArgsSchema, trigger_allowlist: ['user_message'], autonomy_gated: false, handle: file }], entry => logs.push(entry)).respondReceipt({ traceId: 'health-projection-revoke', conversationRef: 'owner', surface: 'app', text }, (_name, work) => work())).rejects.toThrow('Protected owner response unavailable');
  expect(file).not.toHaveBeenCalled(); expect(observed.requests).toHaveLength(3);
  expect(JSON.stringify(logs.map(row => (row as { text?: unknown }).text))).not.toContain('420');
});


const largeProtectedFixture = () => {
  const samples = Array.from({ length: 53 }, (_, index) => healthSampleSchema.parse({ sample_id: 's' + index + '_' + 'a'.repeat(123), revision: 1,
    metric: 'sleep_duration', unit: 'minutes', value: 420, day: '2026-10-10', start_at: '2026-10-10T00:00:00Z', end_at: '2026-10-10T07:00:00Z' }));
  return { context_kind: 'owner_health_sources', sources: [{ summary: { source: 'apple', day: '2026-10-10' }, from: '2026-10-10', to: '2026-10-10', samples,
    coverage: 'complete', returned_samples: 53, clinical_validation: 'not_established' }], custody: 'volatile_owner_health' };
};
it.each(['success', 'provider_failure'] as const)('protected near-bound result never enters ordinary offload across %s and a later turn', async outcome => {
  const text = 'Read my selected current context.';
  const data = largeProtectedFixture();
  const rawSize = JSON.stringify({ ok: true, data }).length;
  expect(rawSize).toBeGreaterThan(16000); expect(rawSize).toBeLessThan(16384);
  const current = async () => {};
  const handler = markProtectedHealthRead({ name: 'get_health' as const, description: 'Synthetic protected health', schema: getHealthArgsSchema,
    trigger_allowlist: triggerTypeSchema.options.filter(trigger => TOOL_PERMISSIONS[trigger].includes('get_health')), autonomy_gated: false, handle: async () => ({ ok: true as const, data, source_taint: null }) }, current);
  const context = createOwnerTurnContext(await admitted(text)).withOwnerHealthSources(async () => [], current, [handler]);
  const logs: unknown[] = [], saved: unknown[] = [];
  const responder = withContext(context, [], event => logs.push(event), { load: async () => ({ entries: [], leafId: null }), save: async entries => { saved.push(entries); } }, undefined, true);
  observed.outputs.push([{ type: 'function_call', call_id: 'large-health', name: 'get_health', arguments: '{}' }], [], []);
  observed.replies.push('', 'Observed sleep: 420 minutes.', JSON.stringify({ continue_owner_task: false, day_load: 'usual', spacing: 'usual', exercise: 'usual', sleep: 'usual', meals: 'usual' }));
  if (outcome === 'provider_failure') observed.afterCall = () => { if (observed.requests.length >= 2) throw new Error('Private synthetic provider detail 420'); };
  const turn = responder.respondReceipt({ traceId: 'large-protected-' + outcome, conversationRef: 'owner', surface: 'app', text }, (_name, work) => work());
  if (outcome === 'provider_failure') await expect(turn).rejects.toThrow('Protected owner response unavailable');
  else expect((await turn).custody.kind).toBe('volatile_owner_health');
  expect(JSON.stringify(observed.requests[1])).toContain('420');
  expect(JSON.stringify(observed.requests[1])).toContain('[cut:');
  expect(JSON.stringify(observed.requests[1])).not.toContain('stored as to-');
  observed.afterCall = undefined; observed.outputs.length = 0; observed.replies.length = 0;
  const firstRequests = observed.requests.length;
  observed.outputs.push([{ type: 'function_call', call_id: 'later-cache', name: 'read_tool_output', arguments: '{"id":"to-1","offset":0,"length":4000}' }], []);
  observed.replies.push('', 'That output is unavailable.');
  const later = await responder.respondReceipt({ traceId: 'later-general-' + outcome, conversationRef: 'owner', surface: 'app', text }, (_name, work) => work());
  expect(later.custody.kind).toBe('durable');
  expect(JSON.stringify(observed.requests.slice(firstRequests))).not.toContain('420');
  expect(JSON.stringify(observed.requests.at(-1))).toContain('No stored output to-1');
  expect(JSON.stringify(logs.map(row => (row as { text?: unknown }).text))).not.toContain('420');
  expect(JSON.stringify(saved)).not.toContain('420');
});
