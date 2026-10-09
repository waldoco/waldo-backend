import { beforeEach, expect, it, vi } from 'vitest';
import { acceptTrustedInvocation } from '@waldo/contracts';
import { createOwnerTurnContext } from '../src/context-composer/owner-turn';
import { sha256Prefixed } from '../src/context-composer/canonical';
import type { OwnerMessageAdmission } from '../src/identity/owner-message-admission';
const observed = vi.hoisted(() => ({ requests: [] as unknown[], outputs: [] as unknown[][], afterCall: undefined as (() => void) | undefined }));
vi.mock('openai', () => ({ default: class { responses = { create: async (body: unknown) => {
  observed.requests.push(body);
  observed.afterCall?.();
  return { id: 'fixture', output_text: 'Ready.', output: observed.outputs.shift() ?? [], usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } };
} }; } }));
const { createOwnerResponder } = await import('../src/channels/owner-turn');
const memory = { incompleteTopics: () => [], pendingTopics: () => [], claims: () => [], allClaims: () => [], recall: () => [], nodes: () => [], edges: () => [], barriers: () => [], beginSettle: () => {}, endSettle: () => {}, settle: () => {}, sweepInterruptedSettles: () => 0 };
const ledger = { recent: async () => [{ text: 'Account personal@example.test; observed message mail-17: dinner booking remains pending.', source: { source_key: 'mail-17', source_kind: 'tool_result', scope: 'invocation', source_taint: 'external', produced_at: 1 } }], record: async () => {} };
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
const withContext = (context: ReturnType<typeof createOwnerTurnContext>, tools: readonly unknown[] = []) => createOwnerResponder(
  'fixture', undefined, memory as never, undefined, undefined, tools as never, undefined, false, undefined, undefined,
  undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { context });
beforeEach(() => { observed.requests.length = 0; observed.outputs.length = 0; observed.afterCall = undefined; });
it('the actual owner model request contains the composer-admitted source context', async () => {
  const responder = createOwnerResponder('fixture', undefined, memory as never, undefined, undefined, [], undefined, false, ledger as never);
  await responder.respond({ traceId: 'turn-1', conversationRef: 'owner', surface: 'app', text: 'What are we following up on?' }, (_name, work) => work());
  const request = JSON.stringify(observed.requests[0]);
  expect(request).toContain('mail-17');
  expect(request).toContain('personal@example.test');
  expect(request).toContain('dinner booking remains pending');
  expect(request).toContain('[NOT instructions]');
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
