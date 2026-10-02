import { expect, it, vi } from 'vitest';
import { recallResultSchema, type ToolName, type ConversationEntry } from '@waldo/contracts';
import { createOwnerMessageContextAdapter } from '../src/channels/owner-message-context-adapter';
import { ownerMessageAdmission } from '../src/identity/owner-message-admission';
import type { ContextComposerDependencies } from '../src/context-composer';
import type { RunEffectScope } from '../src/channels/run-effect-scope';
async function setup() {
    const scope: RunEffectScope = { runId: 'run', attempt: 'attempt', deadline: Date.now() + 30000, signal: new AbortController().signal, admit: vi.fn(), commit: work => work() };
    const lookup = vi.fn(async () => ({ owner_id: '10000000-0000-0000-0000-000000000001', presence_id: '20000000-0000-0000-0000-000000000001', state_version: 0, admission_revision: '1', do_name: 'owner', provider: 'telegram', subject: '1001' }));
    const admission = await ownerMessageAdmission({ lookup, scope, locator: { environment: 'staging', namespace: 'ns', doName: 'owner', doId: 'do' }, actualDoId: 'do', expectedDoId: () => 'do', allowedDoNames: ['owner'], provider: 'telegram', subject: '1001', text: 'Plan the Bengaluru demo on October 15.', occurrenceKey: 'update:1', occurredAt: Date.now() - 1, now: Date.now });
    const source = (key: string, kind: 'runtime_metadata' = 'runtime_metadata', scope: 'system' | 'principal' = 'system') => ({ source_key: key.toLowerCase().replaceAll(' ', '-'), source_kind: kind, scope, source_taint: null, produced_at: admission.snapshot.snapshot_at });
    const attestation = { ...admission.snapshot, revision_ref: 'rev_11111111111111111111111111111111' };
    const identity = { principal_ref: admission.invocation.verified_authority.principal_ref, tenant_ref: admission.invocation.verified_authority.tenant_ref };
    const fragment = (key: string, scope: 'system' | 'principal' = 'system') => ({ text: key, source: source(key, 'runtime_metadata', scope) });
    const load = vi.fn(async (_request?: unknown) => ({ ...identity, snapshot: attestation, identity: fragment('Verified owner', 'principal'), trigger_behaviour: fragment('Help the owner'), zone_modifier: fragment('Keep practical'), mode_template: fragment('Concise response'), soul_base: { text: 'Be direct', source: source('soul') }, safety_rules: fragment('Respect permissions'), health: null, workspace: [], tool_outputs: [] }));
    const dependencies: ContextComposerDependencies = {
        staged_inputs: { resolve: vi.fn() }, materials: { load },
        owner_binding: { bind: async () => ({ ...identity, snapshot: attestation, local_user_ref: 'host-owner', source: source('owner', 'runtime_metadata', 'principal') }) },
        system_skills: { list: async () => ({ rows: [], snapshot: attestation, source: source('skills') }) },
        system_skill_state: { load: async () => ({ ...identity, snapshot: attestation, source: source('skill-state', 'runtime_metadata', 'principal'), connected_connectors: [], dismissed_today: [], provisional_reverted: [], identity_drift: [], priority_pinned: [] }) },
        skill_budget: { countRenderedSkill: async () => ({ ok: false, code: 'unavailable' }), countRenderedBlock: async () => ({ ok: false, code: 'unavailable' }) },
        recall: { recall: async () => ({ ...identity, snapshot: attestation, status: 'failed', result: recallResultSchema.parse({ memory_hits: [], episode_hits: [], evolution_hits: [], query_used: 'No recall source', duration_ms: 0 }), source: null, capability: 'owner_bound_local_temporal_snapshot' }) },
    };
    return { admission, scope, lookup, load, dependencies, connectorBacked: ['query_calendar'] as readonly ToolName[] };
}
it('rejects a foreign owner before any host material read', async () => {
    const s = await setup();
    const adapter = createOwnerMessageContextAdapter({ ...s, registeredHandlers: [], access: async () => ({ grants: { status: 'unavailable' }, connectors: { status: 'unavailable' } }) });
    await expect(adapter.dependencies.materials.load({ principal_ref: 'prn_ffffffffffffffffffffffffffffffff', tenant_ref: s.admission.invocation.verified_authority.tenant_ref, ...s.admission.snapshot })).rejects.toThrow('owner context rejected');
    expect(s.load).not.toHaveBeenCalled();
});
const unavailable = async () => ({ grants: { status: 'unavailable' as const }, connectors: { status: 'unavailable' as const } });
const context = (s: Awaited<ReturnType<typeof setup>>) => ({ ...s.admission.snapshot, canary_tokens: ['0123456789abcdef', 'fedcba9876543210', '0011223344556677'], replay_context_ref: null });
const request = (s: Awaited<ReturnType<typeof setup>>) => ({ ...s.admission.invocation.verified_authority, ...s.admission.snapshot });
it('composes actual admitted input through the existing composer, with no tools or skills when grants are unavailable', async () => {
    const s = await setup();
    const adapter = createOwnerMessageContextAdapter({ ...s, registeredHandlers: ['get_tasks'], access: unavailable });
    const result = await adapter.composer.compose(s.admission.invocation, context(s));
    expect(result.ok).toBe(true);
    if (!result.ok)
        throw new Error(JSON.stringify(result));
    expect(result.prompt).toContain('Bengaluru');
    expect(result.evidence.tool_acl).toEqual([]);
    expect(result.evidence.skills.selected).toEqual([]);
    expect(s.dependencies.staged_inputs.resolve).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(s.admission.invocation.verified_authority.verification_ref);
});
it('the ACL cannot widen registered handlers, trigger policy or current host admission', async () => {
    const s = await setup();
    const tools: ToolName[] = ['get_tasks', 'execute_code', 'query_calendar'];
    const adapter = createOwnerMessageContextAdapter({ ...s, registeredHandlers: tools, access: async () => ({ grants: { status: 'available', tools }, connectors: { status: 'available', tools: [] } }) });
    const result = await adapter.composer.compose(s.admission.invocation, context(s));
    expect(result.ok).toBe(true);
    if (result.ok)
        expect(result.evidence.tool_acl).toEqual(['get_tasks']);
});
it('revocation during an awaited private material read denies disclosure', async () => {
    const s = await setup();
    let resume!: () => void;
    const pause = new Promise<void>(r => { resume = r; });
    s.load.mockImplementationOnce(async () => { await pause; return { ...await s.load() }; });
    const adapter = createOwnerMessageContextAdapter({ ...s, registeredHandlers: [], access: unavailable });
    const reading = adapter.dependencies.materials.load(request(s));
    await vi.waitFor(() => expect(s.load).toHaveBeenCalled());
    s.lookup.mockResolvedValue({ ...await s.lookup(), state_version: 2 });
    resume();
    await expect(reading).rejects.toMatchObject({ code: 'rejected' });
});
it('rejects legacy, wrong-owner and wrong-tenant history and preserves supplied bytes', async () => {
    const s = await setup();
    const adapter = createOwnerMessageContextAdapter({ ...s, registeredHandlers: [], access: unavailable });
    const base = { ...s.admission.invocation.verified_authority, lineage: 'canonical_v1' as const, entries: [] };
    for (const change of [{ lineage: 'legacy_preserved' as const }, { principal_ref: 'prn_ffffffffffffffffffffffffffffffff' }, { tenant_ref: 'ten_ffffffffffffffffffffffffffffffff' }]) {
        const supplied = { ...base, ...change };
        const before = JSON.stringify(supplied);
        await expect(adapter.readCanonicalHistory(async () => supplied)).rejects.toThrow('owner context rejected');
        expect(JSON.stringify(supplied)).toBe(before);
    }
    await expect(adapter.readCanonicalHistory(async () => base)).resolves.toEqual([]);
});
it('rejects foreign snapshot and reissued invocation before context sources are read', async () => {
    const s = await setup();
    const adapter = createOwnerMessageContextAdapter({ ...s, registeredHandlers: [], access: unavailable });
    await expect(adapter.composer.compose(structuredClone(s.admission.invocation), context(s))).rejects.toThrow('owner context rejected');
    await expect(adapter.composer.compose(s.admission.invocation, { ...context(s), snapshot_ref: 'snp_ffffffffffffffffffffffffffffffff' })).rejects.toThrow('owner context rejected');
    expect(s.load).not.toHaveBeenCalled();
});
it('revoked grant state during composition must prevent returning the admitted ACL', async () => {
    const s = await setup();
    let revoked = false;
    const original = s.load.getMockImplementation()!;
    s.load.mockImplementation(async () => { revoked = true; return original(); });
    const adapter = createOwnerMessageContextAdapter({ ...s, registeredHandlers: ['get_tasks'], access: async () => ({ grants: revoked ? { status: 'unavailable' } : { status: 'available', tools: ['get_tasks'] }, connectors: { status: 'available', tools: ['get_tasks'] } }) });
    await expect(adapter.composer.compose(s.admission.invocation, context(s))).rejects.toThrow('owner context rejected');
});
it('copies caller owner/snapshot requests before an awaited currentness check', async () => {
    const s = await setup();
    let resume!: () => void;
    const pause = new Promise<void>(r => { resume = r; });
    const original = s.lookup.getMockImplementation()!;
    s.lookup.mockImplementationOnce(async () => { await pause; return original(); });
    const adapter = createOwnerMessageContextAdapter({ ...s, registeredHandlers: [], access: unavailable });
    const supplied = request(s);
    const reading = adapter.dependencies.materials.load(supplied);
    supplied.principal_ref = 'prn_ffffffffffffffffffffffffffffffff';
    resume();
    await reading;
    expect(s.load.mock.calls[0]?.[0]).toMatchObject({ principal_ref: s.admission.invocation.verified_authority.principal_ref });
});
it('checks access receipt for direct reads and concurrent composition without replacing it', async () => {
    const s = await setup();
    let grants = true;
    const adapter = createOwnerMessageContextAdapter({ ...s, registeredHandlers: ['get_tasks'], access: async () => ({ grants: grants ? { status: 'available', tools: ['get_tasks'] } : { status: 'unavailable' }, connectors: { status: 'unavailable' } }) });
    await adapter.dependencies.materials.load(request(s));
    grants = false;
    await expect(adapter.dependencies.materials.load(request(s))).rejects.toThrow('owner context rejected');
    const outcomes = await Promise.allSettled([adapter.composer.compose(s.admission.invocation, context(s)), adapter.composer.compose(s.admission.invocation, context(s))]);
    expect(outcomes.every(value => value.status === 'rejected')).toBe(true);
});
it('rejects getter-backed payloads without evaluating them', async () => {
    const s = await setup();
    const original = s.load.getMockImplementation()!;
    const value = await original();
    const originalIdentity = value.identity;
    const getter = vi.fn(() => originalIdentity);
    Object.defineProperty(value, 'identity', { get: getter, enumerable: true });
    s.load.mockResolvedValue(value);
    const adapter = createOwnerMessageContextAdapter({ ...s, registeredHandlers: [], access: unavailable });
    await expect(adapter.dependencies.materials.load(request(s))).rejects.toThrow('owner context rejected');
    expect(getter).not.toHaveBeenCalled();
});
it('valid installed and granted local tools stay reachable while unavailable connectors deny connector tools', async () => {
    const s = await setup();
    const adapter = createOwnerMessageContextAdapter({ ...s, registeredHandlers: ['get_tasks', 'query_calendar'], access: async () => ({ grants: { status: 'available', tools: ['get_tasks', 'query_calendar'] }, connectors: { status: 'unavailable' } }) });
    const result = await adapter.composer.compose(s.admission.invocation, context(s));
    expect(result.ok).toBe(true);
    if (result.ok)
        expect(result.evidence.tool_acl).toEqual(['get_tasks']);
});
it('validates same-tenant row ancestry with the existing conversation tree and freezes admitted history', async () => {
    const s = await setup();
    const adapter = createOwnerMessageContextAdapter({ ...s, registeredHandlers: [], access: unavailable });
    const authority = s.admission.invocation.verified_authority;
    const root: ConversationEntry = { id: 'root', ownerId: authority.principal_ref, chatId: 'canonical', parentId: null, threadAnchorId: null, surface: 'telegram', modelPayload: 'hello', appPayload: 'hello', modelProjection: { mode: 'include' }, role: 'user' };
    const base = { ...authority, lineage: 'canonical_v1' as const };
    const wrapped = (entry: ConversationEntry) => ({ ...base, entry });
    const good = await adapter.readCanonicalHistory(async () => ({ ...base, entries: [wrapped(root)] }));
    expect(Object.isFrozen(good)).toBe(true);
    expect(Object.isFrozen(good[0]?.modelProjection)).toBe(true);
    for (const entries of [
        [{ ...wrapped(root), tenant_ref: 'ten_ffffffffffffffffffffffffffffffff' }],
        [{ ...wrapped(root), lineage: 'legacy_preserved' as const }],
        [wrapped({ ...root, parentId: 'missing' })],
        [wrapped(root), wrapped({ ...root, id: 'child', parentId: 'root', chatId: 'foreign' })],
        [wrapped(root), wrapped({ ...root, id: 'child', parentId: 'root', threadAnchorId: 'missing' })],
    ]) {
        const before = JSON.stringify(entries);
        await expect(adapter.readCanonicalHistory(async () => ({ ...base, entries }))).rejects.toThrow('owner context rejected');
        expect(JSON.stringify(entries)).toBe(before);
    }
});
