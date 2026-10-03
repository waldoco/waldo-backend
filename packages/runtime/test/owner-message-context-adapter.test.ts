import { expect, it, vi } from 'vitest';
import { recallResultSchema, type ToolName, type ConversationEntry } from '@waldo/contracts';
import { createOwnerMessageContextAdapter } from '../src/channels/owner-message-context-adapter';
import { ownerMessageAdmission } from '../src/identity/owner-message-admission';
import type { ContextComposerDependencies } from '../src/context-composer';
import type { RunEffectScope } from '../src/channels/run-effect-scope';
import { env, runInDurableObject } from 'cloudflare:test';
import { claimStore } from '../src/memory/claims';
import { createOwnerResponder } from '../src/channels/owner-turn';
import type { LLMGatewayAdapter } from '../src/llm/provider';
import { episodeIndex } from '../src/channels/episodes';
import { ownerCanonicalHistory } from '../src/channels/owner-canonical-history';
import { redactConversationEntries } from '../src/channels/conversation-store';
import { FORGOTTEN } from '../src/memory/claims';
import { toolOutputLedger } from '../src/conversation/tool-output-ledger';
async function setup(text = 'Plan the Bengaluru demo on October 15.') {
    const scope: RunEffectScope = { runId: 'run', attempt: 'attempt', deadline: Date.now() + 30000, signal: new AbortController().signal, admit: vi.fn(), commit: work => work() };
    const lookup = vi.fn(async () => ({ owner_id: '10000000-0000-0000-0000-000000000001', presence_id: '20000000-0000-0000-0000-000000000001', state_version: 0, admission_revision: '1', do_name: 'owner', provider: 'telegram', subject: '1001' }));
    const admission = await ownerMessageAdmission({ lookup, scope, locator: { environment: 'staging', namespace: 'ns', doName: 'owner', doId: 'do' }, actualDoId: 'do', expectedDoId: () => 'do', allowedDoNames: ['owner'], provider: 'telegram', subject: '1001', text, occurrenceKey: 'update:1', occurredAt: Date.now() - 1, now: Date.now });
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

it('explicit owner retry retires previously selected empty coverage but never unproved empty intent', async () => {
    await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('forget-canonical-empty-recovery')), async (_instance, state) => {
        const topic = 'DLD-20261002-M3';
        const fact = `${topic} workshop preference: Friday at 09:10 UTC`;
        const at = '2026-10-03T12:00:00Z';
        const memory = claimStore(state.storage.sql);
        const episodes = episodeIndex(state.storage.sql);
        episodes.add('tg-original-before-interruption', 'owner', fact, 1);
        memory.beginTopicCoverage(topic, at);
        memory.authoriseTopicCoverage(topic, [fact], at);
        const targets = memory.pendingTopics();
        expect(memory.purge([], at, targets).ready).toBe(true);
        // Simulate interruption after selected clauses leave SQL, before KV readback.
        memory.settle([], targets);
        expect(memory.topicCoverage(topic)).toBe(2);
        expect(memory.incompleteTopics()).toEqual([topic]);
        const s = await setup(`Retry: forget only ${topic}`);
        const adapter = createOwnerMessageContextAdapter({ ...s, retainedRecallAvailable: () => memory.incompleteTopics().length === 0, registeredHandlers: [], connectorBacked: [], access: unavailable });
        const store = ownerCanonicalHistory(state.storage, s.admission, adapter);
        const gateway: LLMGatewayAdapter = { complete: async request => {
            const phase = request.request.response_format?.name;
            const text = phase === 'claim_ops' ? JSON.stringify({ add: [], corrections: [], seen: [], confirm: [], dismiss: [], forget_claims: [], forget_nodes: [], forget_topic: topic }) : 'pong';
            return { ok: true, data: { model: request.request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, output_items: [], latency_ms: 0 } };
        } };
        const args: Parameters<typeof createOwnerResponder> = ['fixture', store, memory];
        args[10] = gateway; args[19] = s.scope;
        args[21] = { binding: { admission: s.admission, adapter, store, forgetting: { ...s.admission.invocation.verified_authority, store: memory } } };
        await createOwnerResponder(...args).respond({ traceId: 'tg-empty-retry', conversationRef: 'owner', surface: 'telegram', text: `Retry: forget only ${topic}` }, (_name, work) => work());
        expect(memory.incompleteTopics()).toEqual([]);
        expect(memory.pendingTopics()).toEqual([]);
        expect(memory.topicCoverage(topic)).toBeNull();
        const unknown = 'DLD-unproved-source';
        memory.beginTopicCoverage(unknown, at);
        memory.settle([], [], unknown);
        expect(memory.topicCoverage(unknown)).toBe(1);
    });
});

it('a new source arriving during final currentness checking stays intact and keeps coverage incomplete', async () => {
    await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('forget-canonical-late-source')), async (_instance, state) => {
        const topic = 'DLD-20261002-M3';
        const fact = `${topic} workshop preference: Friday at 09:10 UTC`;
        const late = `${topic} workshop preference: Tuesday at 10:40 UTC`;
        const s = await setup(`Forget only ${topic}`);
        const memory = claimStore(state.storage.sql);
        const episodes = episodeIndex(state.storage.sql);
        episodes.add('tg-original-source', 'owner', fact, 1);
        const adapter = createOwnerMessageContextAdapter({ ...s, retainedRecallAvailable: () => memory.incompleteTopics().length === 0, registeredHandlers: [], connectorBacked: [], access: unavailable });
        const store = ownerCanonicalHistory(state.storage, s.admission, adapter);
        const ledger = toolOutputLedger(state.storage);
        let reads = 0, afterFresh = false, inserted = false;
        const original = ledger.forgetSources.bind(ledger);
        ledger.forgetSources = async topic => { const result = await original(topic); afterFresh = ++reads === 2; return result; };
        const lookup = s.lookup.getMockImplementation()!;
        s.lookup.mockImplementation(async () => {
            if (afterFresh && !inserted) { inserted = true; episodes.add('tg-late-source', 'owner', late, 2); }
            return lookup();
        });
        const gateway: LLMGatewayAdapter = { complete: async request => {
            const phase = request.request.response_format?.name;
            const text = phase === 'claim_ops' ? JSON.stringify({ add: [], corrections: [], seen: [], confirm: [], dismiss: [], forget_claims: [], forget_nodes: [], forget_topic: topic }) : phase === 'forget_source_spans' ? JSON.stringify({ spans: [{ ref: 'episodes:1:text', text: fact }], reviewed_refs: ['episodes:1:text'], complete: true }) : 'pong';
            return { ok: true, data: { model: request.request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, output_items: [], latency_ms: 0 } };
        } };
        const args: Parameters<typeof createOwnerResponder> = ['fixture', store, memory];
        args[8] = ledger; args[10] = gateway; args[19] = s.scope;
        args[21] = { binding: { admission: s.admission, adapter, store, forgetting: { ...s.admission.invocation.verified_authority, store: memory } } };
        await createOwnerResponder(...args).respond({ traceId: 'tg-canonical-late', conversationRef: 'owner', surface: 'telegram', text: `Forget only ${topic}` }, (_name, work) => work());
        expect(inserted).toBe(true);
        expect(episodes.get('1')!.text).toBe(fact);
        expect(episodes.get('2')!.text).toBe(late);
        expect(memory.incompleteTopics()).toEqual([topic]);
        expect(memory.pendingTopics()).toEqual([]);
    });
});

it('canonical first-writer failure reaches the reply as a truthful forget-specific notice', async () => {
    await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('forget-canonical-writer-failure')), async (_instance, state) => {
        const topic = 'DLD-20261002-M3';
        const s = await setup(`Forget only ${topic}`);
        const memory = claimStore(state.storage.sql);
        const adapter = createOwnerMessageContextAdapter({ ...s, registeredHandlers: [], connectorBacked: [], access: unavailable });
        const store = ownerCanonicalHistory(state.storage, s.admission, adapter);
        const replies: string[] = [];
        const gateway: LLMGatewayAdapter = { complete: async request => {
            if (request.request.response_format) return { ok: false, code: 'auth_failed', error: 'fictional provider unavailable' };
            replies.push(JSON.stringify(request.request));
            return { ok: true, data: { model: request.request.model, text: 'pong', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, output_items: [], latency_ms: 0 } };
        } };
        const args: Parameters<typeof createOwnerResponder> = ['fixture', store, memory];
        args[10] = gateway; args[19] = s.scope;
        args[21] = { binding: { admission: s.admission, adapter, store, forgetting: { ...s.admission.invocation.verified_authority, store: memory } } };
        await createOwnerResponder(...args).respond({ traceId: 'tg-canonical-failed-forget', conversationRef: 'owner', surface: 'telegram', text: `Forget only ${topic}` }, (_name, work) => work());
        expect(replies.join('\n')).toContain('Requested forgetting could not be verified');
        expect(replies.join('\n')).not.toContain("Saving the owner's latest message to memory failed");
        expect(memory.incompleteTopics()).toEqual([]);
    });
});

it('canonical owner request reaches the source selector and verified cleanup without admitting legacy claim writes', async () => {
    await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('forget-canonical-source-lifecycle')), async (_instance, state) => {
        const topic = 'DLD-20261002-M3';
        const fact = `${topic} workshop preference: Friday at 09:10 UTC`;
        const s = await setup(`Forget only ${topic}. Keep unrelated preferences.`);
        const memory = claimStore(state.storage.sql);
        const episodes = episodeIndex(state.storage.sql);
        episodes.add('tg-mixed', 'owner', `${fact}. Unrelated preference: tea after lunch.`, 1);
        episodes.add('tg-other', 'owner', 'Other workshop preference: Friday at 09:10 UTC.', 2);
        const adapter = createOwnerMessageContextAdapter({ ...s, retainedRecallAvailable: () => memory.incompleteTopics().length === 0, registeredHandlers: ['get_context'], connectorBacked: [], access: async () => ({ grants: { status: 'available', tools: ['get_context'] }, connectors: { status: 'available', tools: [] } }) });
        const captured: { phase: string; request: string }[] = [];
        const gateway: LLMGatewayAdapter = { complete: async request => {
            const phase = request.request.response_format?.name ?? 'reply';
            captured.push({ phase, request: JSON.stringify(request.request) });
            const supplied = phase === 'forget_source_spans' ? JSON.parse(request.request.messages[0]!.content) as { sources: { ref: string; text: string }[] } : null;
            const text = phase === 'claim_ops' ? JSON.stringify({ corrections: [], seen: [], confirm: [], dismiss: [], forget_claims: [], forget_nodes: [], forget_topic: topic, add: [{ kind: 'preference', text: 'Unauthorized new legacy claim', source: 'stated', evidence: 'invented', touches_forgotten: false }] }) : supplied ? JSON.stringify({ spans: supplied.sources.map(row => ({ ref: row.ref, text: fact })), reviewed_refs: supplied.sources.map(row => row.ref), complete: true }) : 'pong';
            return { ok: true, data: { model: request.request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, output_items: [], latency_ms: 0 } };
        } };
        const store = ownerCanonicalHistory(state.storage, s.admission, adapter);
        const ownerId = s.admission.invocation.verified_authority.principal_ref;
        await store.save([{ id: 'tg-old-owned-source', parentId: null, threadAnchorId: null, ownerId, chatId: 'owner', surface: 'telegram', role: 'user', modelPayload: `${fact}. Unrelated preference: tea after lunch.`, appPayload: `${fact}. Unrelated preference: tea after lunch.`, modelProjection: { mode: 'include' } }], 'tg-old-owned-source', s.scope);
        const args: Parameters<typeof createOwnerResponder> = ['fixture', store, memory];
        args[10] = gateway;
        args[11] = (texts, scope) => redactConversationEntries(state.storage, texts, FORGOTTEN, scope);
        args[19] = s.scope;
        args[21] = { binding: { admission: s.admission, adapter, store, forgetting: { ...s.admission.invocation.verified_authority, store: memory } } };
        const foreign = [...args] as Parameters<typeof createOwnerResponder>;
        foreign[21] = { binding: { admission: s.admission, adapter, store, forgetting: { ...s.admission.invocation.verified_authority, principal_ref: 'prn_ffffffffffffffffffffffffffffffff', store: memory } } };
        expect(() => createOwnerResponder(...foreign)).toThrow('forgetting owner binding rejected');
        expect(captured).toEqual([]);
        const responder = createOwnerResponder(...args);
        await responder.respond({ traceId: 'tg-canonical-forget', conversationRef: 'owner', surface: 'telegram', text: `Forget only ${topic}. Keep unrelated preferences.` }, (_name, work) => work());
        expect(captured.map(row => row.phase)).toContain('forget_source_spans');
        expect(captured.find(row => row.phase === 'claim_ops')!.request).not.toContain(fact);
        expect(episodes.get('1')!.text).not.toContain('09:10 UTC');
        expect(episodes.get('1')!.text).toContain('tea after lunch');
        expect(episodes.get('2')!.text).toContain('09:10 UTC');
        expect(memory.claims()).toEqual([]);
        expect(memory.pendingTopics()).toEqual([]);
        expect(memory.incompleteTopics()).toEqual([]);
        expect(captured.filter(row => row.phase === 'reply').every(row => !row.request.includes('09:10 UTC'))).toBe(true);
        const old = (await store.load()).entries.find(entry => entry.id === 'tg-old-owned-source')!;
        expect(old.modelPayload).toContain('tea after lunch');
        expect(old.modelPayload).not.toContain('09:10 UTC');
        expect(old.appPayload).not.toContain('09:10 UTC');
    });
});

it('revocation during the final awaited source supplier preserves original facts and incomplete custody', async () => {
    await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('forget-canonical-revoked-source')), async (_instance, state) => {
        const topic = 'DLD-20261002-M3';
        const fact = `${topic} workshop preference: Friday at 09:10 UTC`;
        const s = await setup(`Forget only ${topic}`);
        const memory = claimStore(state.storage.sql);
        const episodes = episodeIndex(state.storage.sql);
        episodes.add('tg-revoked-source', 'owner', fact, 1);
        const adapter = createOwnerMessageContextAdapter({ ...s, registeredHandlers: [], connectorBacked: [], access: unavailable });
        const store = { load: async () => ({ entries: [], leafId: null }), save: async () => undefined };
        const ledger = toolOutputLedger(state.storage);
        let reads = 0;
        const original = ledger.forgetSources.bind(ledger);
        ledger.forgetSources = async topic => {
            const result = await original(topic);
            if (++reads === 2) s.lookup.mockResolvedValue({ ...await s.lookup(), state_version: 2 });
            return result;
        };
        const gateway: LLMGatewayAdapter = { complete: async request => {
            const phase = request.request.response_format?.name;
            const text = phase === 'claim_ops' ? JSON.stringify({ add: [], corrections: [], seen: [], confirm: [], dismiss: [], forget_claims: [], forget_nodes: [], forget_topic: topic }) : JSON.stringify({ spans: [{ ref: 'episodes:1:text', text: fact }], reviewed_refs: ['episodes:1:text'], complete: true });
            return { ok: true, data: { model: request.request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, output_items: [], latency_ms: 0 } };
        } };
        const args: Parameters<typeof createOwnerResponder> = ['fixture', store, memory];
        args[8] = ledger;
        args[10] = gateway;
        args[19] = s.scope;
        args[21] = { binding: { admission: s.admission, adapter, store, forgetting: { ...s.admission.invocation.verified_authority, store: memory } } };
        await expect(createOwnerResponder(...args).respond({ traceId: 'tg-canonical-revoked', conversationRef: 'owner', surface: 'telegram', text: `Forget only ${topic}` }, (_name, work) => work())).rejects.toBeDefined();
        expect(reads).toBe(2);
        expect(episodes.get('1')!.text).toBe(fact);
        expect(memory.incompleteTopics()).toEqual([topic]);
        expect(memory.pendingTopics()).toEqual([]);
        expect(memory.barriers()).toEqual([]);
    });
});

it('canonical provider capture keeps current input, safeguards and live tools while incomplete retained recall is withheld', async () => {
    await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('forget-canonical-provider-capture')), async (_instance, state) => {
        const s = await setup();
        const memory = claimStore(state.storage.sql);
        const topic = 'DLD-20261002-M3';
        const fact = `${topic} workshop preference: Friday at 09:10 UTC`;
        memory.beginTopicCoverage(topic, '2026-10-03T12:00:00Z');
        const base = await s.load();
        const materials = { load: async () => ({ ...base, tool_outputs: [{ text: fact, source: base.identity.source }] }) };
        const recall = vi.fn(async () => { throw new Error('retained recall supplier must not run'); });
        const dependencies = { ...s.dependencies, materials, recall: { recall } };
        const adapter = createOwnerMessageContextAdapter({ ...s, dependencies, retainedRecallAvailable: () => memory.incompleteTopics().length === 0, registeredHandlers: ['get_context'], connectorBacked: [], access: async () => ({ grants: { status: 'available', tools: ['get_context'] }, connectors: { status: 'available', tools: [] } }) });
        const captured: string[] = [];
        let first = true;
        const gateway: LLMGatewayAdapter = { complete: async request => {
            captured.push(JSON.stringify(request.request));
            const tool_calls = first ? [{ call_id: 'canonical-live-clock', name: 'get_context', arguments: '{}' }] : undefined;
            first = false;
            return { ok: true, data: { model: request.request.model, text: tool_calls ? '' : 'pong', ...(tool_calls ? { tool_calls } : {}), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, output_items: [], latency_ms: 0 } };
        } };
        const entries: ConversationEntry[] = [];
        const store = { load: async () => ({ entries, leafId: null }), save: async (next: readonly ConversationEntry[]) => { entries.push(...next); } };
        const args: Parameters<typeof createOwnerResponder> = ['fixture', store, memory];
        args[10] = gateway;
        args[21] = { binding: { admission: s.admission, adapter, store } };
        const logs: { hop: string; ok?: boolean }[] = [];
        args[3] = entry => { logs.push(entry); };
        const responder = createOwnerResponder(...args);
        await responder.respond({ traceId: 'tg-canonical-current', conversationRef: 'owner', surface: 'telegram', text: 'Plan the Bengaluru demo on October 15.', memoryWrites: false }, (_name, work) => work());
        expect(captured.length).toBeGreaterThanOrEqual(2);
        expect(captured.join('\n')).toContain('Bengaluru demo');
        expect(captured.join('\n')).toContain('Respect permissions');
        expect(captured.join('\n')).toContain('Recall is temporarily limited');
        expect(captured.join('\n')).not.toContain(fact);
        expect(captured.join('\n')).not.toContain('09:10 UTC');
        expect(logs.some(entry => entry.hop === 'tool_get_context' && entry.ok)).toBe(true);
        expect(recall).not.toHaveBeenCalled();
        expect(memory.incompleteTopics()).toEqual([topic]);
    });
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

it('limited canonical tasks never invoke the ordinary material bundle or retained recall supplier', async () => {
    const s = await setup('Only use the current supplied data');
    const safe = await s.load();
    s.load.mockClear();
    const recall = vi.fn(s.dependencies.recall.recall);
    const taskMaterials = vi.fn(async () => safe);
    const adapter = createOwnerMessageContextAdapter({ ...s, dependencies: { ...s.dependencies, recall: { recall } }, taskMaterials, registeredHandlers: [], access: async () => ({ grants: { status: 'available', tools: [] }, connectors: { status: 'available', tools: [] } }) });
    adapter.setTaskSources({ taskId: 'task', revision: 1, ready: true, sources: [], startRef: 'owner-input' });
    const request = { ...s.admission.invocation.verified_authority, ...s.admission.snapshot };
    await adapter.dependencies.materials.load(request);
    expect(taskMaterials).toHaveBeenCalledWith(request, []);
    expect(s.load).not.toHaveBeenCalled();
    const result = await adapter.dependencies.recall.recall({ ...request, owner: s.admission.invocation.verified_authority, query: 'retained sentinel' } as never);
    expect(result.result.memory_hits).toEqual([]);
    expect(recall).not.toHaveBeenCalled();
    const absent = createOwnerMessageContextAdapter({ ...s, registeredHandlers: [], access: async () => ({ grants: { status: 'available', tools: [] }, connectors: { status: 'available', tools: [] } }) });
    absent.setTaskSources({ taskId: 'task', revision: 1, ready: true, sources: [], startRef: 'owner-input' });
    await expect(absent.dependencies.materials.load(request)).rejects.toThrow('owner context rejected');
    expect(s.load).not.toHaveBeenCalled();
});
