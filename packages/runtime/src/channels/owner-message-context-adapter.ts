import { TASK_SOURCE_FAMILIES, type TaskSourceFamily, type TaskSourceSnapshot } from './task-source-scope';
import { ConversationTree, intersectToolAcl, type ToolAclSource, type ToolName, type ConversationEntry } from '@waldo/contracts';
import { createContextComposer, type ContextComposer, type ContextComposerDependencies } from '../context-composer';
import type { OwnerMessageAdmission } from '../identity/owner-message-admission';
import type { RunEffectScope } from './run-effect-scope';
// Private host dependencies only. Local lineage/access types await Core's canonical contracts.
type Access = ToolAclSource;
type HistoryRow = Readonly<{
    lineage: 'canonical_v1' | 'legacy_preserved';
    principal_ref: string;
    tenant_ref: string;
    entry: ConversationEntry;
}>;
type History = Readonly<{
    lineage: 'canonical_v1' | 'legacy_preserved';
    principal_ref: string;
    tenant_ref: string;
    entries: readonly HistoryRow[];
}>;
type Options = Readonly<{
    admission: OwnerMessageAdmission;
    scope: RunEffectScope;
    dependencies: ContextComposerDependencies;
    registeredHandlers: readonly ToolName[];
    connectorBacked: readonly ToolName[];
    retainedRecallAvailable?: () => boolean;
    taskMaterials?: (request: Parameters<ContextComposerDependencies['materials']['load']>[0], sources: readonly TaskSourceFamily[]) => ReturnType<ContextComposerDependencies['materials']['load']>;
    access(): Promise<Readonly<{
        grants: Access;
        connectors: Access;
    }>>;
}>;
export class OwnerContextRejected extends Error {
    constructor() { super('owner context rejected'); }
}
// Snapshot plain host data without evaluating accessors or retaining mutable supplier objects.
function copy<T>(value: T): T {
    const seen = new Set<object>();
    const visit = (item: unknown): unknown => {
        if (item === null || typeof item !== 'object') {
            if (typeof item === 'function' || typeof item === 'symbol')
                throw new OwnerContextRejected();
            return item;
        }
        if (seen.has(item) || Object.getOwnPropertySymbols(item).length
            || Object.getPrototypeOf(item) !== (Array.isArray(item) ? Array.prototype : Object.prototype))
            throw new OwnerContextRejected();
        seen.add(item);
        const result: Record<string, unknown> | unknown[] = Array.isArray(item) ? [] : {};
        for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
            if (!('value' in descriptor))
                throw new OwnerContextRejected();
            if (Array.isArray(item) && key === 'length')
                continue;
            Object.defineProperty(result, key, { value: visit(descriptor.value), enumerable: true });
        }
        seen.delete(item);
        return Object.freeze(result);
    };
    return visit(value) as T;
}
export function createOwnerMessageContextAdapter(options: Options) {
    const { admission, scope } = options;
    const authority = admission.invocation.verified_authority;
    const snapshot = admission.snapshot;
    const registered = new Set(options.registeredHandlers);
    const connectorBacked = [...options.connectorBacked];
    const deps = options.dependencies;
    let taskSources: TaskSourceSnapshot | undefined;
    const permits = (family: TaskSourceFamily) => !taskSources || taskSources.ready && taskSources.sources.includes(family);
    const setTaskSources = (snapshot: TaskSourceSnapshot) => { taskSources = snapshot; };
    const readAccess = options.access;
    let accessAdmission: Promise<Awaited<ReturnType<Options['access']>>> | undefined;
    const accessKey = (value: Awaited<ReturnType<Options['access']>>) => JSON.stringify([value.grants.status,
        value.grants.status === 'available' ? [...value.grants.tools].sort() : [], value.connectors.status,
        value.connectors.status === 'available' ? [...value.connectors.tools].sort() : []]);
    const reject = () => { throw new OwnerContextRejected(); };
    const identityCurrent = async () => { scope.admit(); await admission.assertCurrent(); scope.admit(); };
    const accessSnapshot = () => accessAdmission ??= (async () => {
        await identityCurrent();
        const result = copy(await readAccess());
        await identityCurrent();
        return result;
    })();
    const assertCurrent = async () => {
        const admitted = await accessSnapshot();
        await identityCurrent();
        const current = copy(await readAccess());
        await identityCurrent();
        if (accessKey(current) !== accessKey(admitted))
            reject();
    };
    const check = (request: Readonly<{
        principal_ref?: string;
        tenant_ref?: string;
        snapshot_ref: string;
        snapshot_at: number;
    }>, owner = true) => {
        if (request.snapshot_ref !== snapshot.snapshot_ref || request.snapshot_at !== snapshot.snapshot_at
            || (owner && request.principal_ref !== authority.principal_ref)
            || (owner && request.tenant_ref !== authority.tenant_ref))
            reject();
    };
    const guarded = async <T>(work: () => Promise<T>): Promise<T> => {
        await assertCurrent();
        // Copy source bytes before the awaited currentness check can yield back to its supplier.
        const result = copy(await work());
        await assertCurrent();
        return result;
    };
    const bound = async <T extends { principal_ref: string; tenant_ref: string; snapshot: { snapshot_ref: string; snapshot_at: number } }>(work: () => Promise<T>): Promise<T> => {
        const result = await guarded(work);
        check({ ...result.snapshot, principal_ref: result.principal_ref, tenant_ref: result.tenant_ref });
        return result;
    };
    const materialsLoad = deps.materials.load.bind(deps.materials);
    const ownerBind = deps.owner_binding?.bind.bind(deps.owner_binding);
    const skillList = deps.system_skills?.list.bind(deps.system_skills);
    const skillState = deps.system_skill_state?.load.bind(deps.system_skill_state);
    const recall = deps.recall?.recall.bind(deps.recall);
    const dependencies: ContextComposerDependencies = Object.freeze({
        ...deps,
        staged_inputs: { resolve: async (supplied) => {
                const request = copy(supplied);
                check(request);
                if (request.input_refs.length !== 1 || request.input_refs[0]?.input_ref !== admission.invocation.input_refs[0]?.input_ref
                    || request.input_refs[0]?.content_digest !== admission.invocation.input_refs[0]?.content_digest)
                    reject();
                const input = await guarded(() => admission.readInput());
                return { inputs: [{ ...input, source: { ...input.source, scope: 'invocation' as const } }],
                    snapshot: { ...snapshot, revision_ref: `rev_${input.content_digest.slice(7, 39)}` },
                    source: { source_key: 'owner-message-input-snapshot', source_kind: 'runtime_metadata' as const, scope: 'invocation' as const, source_taint: null, produced_at: snapshot.snapshot_at } };
            } },
        materials: { load: async (supplied) => {
                const request = copy(supplied); check(request);
                const limited = taskSources && (!taskSources.ready || taskSources.sources.length < TASK_SOURCE_FAMILIES.length);
                if (limited && !options.taskMaterials) reject();
                const result = await bound(() => limited ? options.taskMaterials!(request, taskSources!.ready ? taskSources!.sources : []) : materialsLoad(request));
                if ((!permits('local') && (result.health || result.tool_outputs.length)) || (!permits('workspace') && result.workspace.length)) reject();
                return options.retainedRecallAvailable?.() === false ? { ...result, tool_outputs: [] } : result;
            } },
        owner_binding: { bind: async (supplied) => { const request = copy(supplied); check(request); return bound(() => ownerBind(request)); } },
        system_skills: { list: async (supplied) => {
                const request = copy(supplied);
                check(request, false);
                const result = await guarded(() => skillList(request));
                // This slice has zero active skills; a host cannot accidentally activate a repository.
                if (result.rows.length)
                    reject();
                return result;
            } },
        system_skill_state: { load: async (supplied) => { const request = copy(supplied); check(request); return bound(() => skillState(request)); } },
        recall: { recall: async (supplied) => {
                const request = copy(supplied);
                check({ ...request, principal_ref: request.owner.principal_ref, tenant_ref: request.owner.tenant_ref });
                const unavailable = () => ({
                    principal_ref: authority.principal_ref, tenant_ref: authority.tenant_ref,
                    snapshot: { ...snapshot, revision_ref: 'rev_00000000000000000000000000000000' },
                    status: 'failed' as const,
                    result: { memory_hits: [], episode_hits: [], evolution_hits: [], query_used: 'Retained recall temporarily limited: forgetting coverage incomplete', duration_ms: 0 },
                    source: null, capability: 'owner_bound_local_temporal_snapshot' as const,
                });
                await assertCurrent();
                if (options.retainedRecallAvailable?.() === false || !permits('local')) return unavailable();
                const result = await bound(() => recall(request));
                return options.retainedRecallAvailable?.() === false || !permits('local') ? unavailable() : result;
            } },
    });
    const base = createContextComposer(dependencies);
    const composer: ContextComposer = Object.freeze({ compose: async (invocation, supplied) => {
            const context = copy(supplied);
            // Only this exact host-issued capability can select identity/input; no caller reissuance.
            if (invocation !== admission.invocation || context.replay_context_ref !== null)
                reject();
            check({ ...context, principal_ref: invocation.verified_authority.principal_ref, tenant_ref: invocation.verified_authority.tenant_ref });
            const access = await accessSnapshot();
            await assertCurrent();
            const result = await base.compose(invocation, context);
            await assertCurrent();
            if (!result.ok)
                return result;
            if (result.skillPrompt || result.evidence.skills.selected.length)
                reject();
            const admitted = intersectToolAcl({ handlers: [...registered], trigger: invocation.runtime_binding.trigger,
                grants: access.grants, connectors: access.connectors, connector_backed: connectorBacked });
            const acl = admitted.tools.filter(tool => result.evidence.tool_acl.includes(tool));
            return Object.freeze({ ...result, evidence: Object.freeze({ ...result.evidence, tool_acl: Object.freeze(acl) }) });
        } });
    const readCanonicalHistory = async (read: () => Promise<History>): Promise<readonly ConversationEntry[]> => {
        const result = await guarded(read);
        if (result.lineage !== 'canonical_v1' || result.principal_ref !== authority.principal_ref || result.tenant_ref !== authority.tenant_ref
            || result.entries.some(row => row.lineage !== 'canonical_v1' || row.principal_ref !== authority.principal_ref
                || row.tenant_ref !== authority.tenant_ref || row.entry.ownerId !== authority.principal_ref))
            reject();
        const tree = new ConversationTree();
        try {
            for (const row of result.entries)
                tree.append(row.entry);
        }
        catch {
            reject();
        }
        return Object.freeze(result.entries.map(row => tree.get(row.entry.id)!));
    };
    return Object.freeze({ dependencies, composer, assertCurrent, readCanonicalHistory, setTaskSources });
}
