import type { SetProactivityArgs } from '@waldo/contracts';
import { calendarPromptProjection, GoogleError, sha256Hex, type CalendarItem, type GoogleClient, type GoogleFeature, type TaskItem, type ThreadMessage } from '../connectors/google';
import { googleCalendarPushEvent, validGooglePushAddress, type GoogleCalendarPushWitness, type GoogleCalendarWatch } from '../connectors/google-push';
import type { GoogleAccess } from '../tools/live/google';
import { extractArtifactFields, extractArtifacts } from '../security/artifact-hygiene';
import type { ProactivityBook } from '../proactivity/book';
import { PROACTIVITY_DISCOVERY_INSTRUCTION, PROACTIVITY_DISCOVERY_SCHEMA, parseDiscoveryCandidates } from '../proactivity/discovery';
import { PROACTIVITY_DECISION_INSTRUCTION, PROACTIVITY_DECISION_SCHEMA, parseProactiveDecision } from '../proactivity/judgment';
import { proactivityDeliveryEligible, runProactivityCycle, type ProactivityPorts } from '../proactivity/runner';
import { ProactivityConflict, type Delivery, type Observation, type SourceKey, type SourceRef, type Watch } from '../proactivity/types';
import type { LoopBook } from './loops';
import type { ResponsibilityBook } from './responsibilities';
import { collectChanges, type UpdateBook } from './update-cards';
import { localIso, localToEpoch } from './reminders';

type Sql = Pick<SqlStorage, 'exec'>;
export type OwnerProactivityAccount = Readonly<{
  id: string; email: string; revision: string; connected: boolean; available: boolean;
  features: Readonly<Partial<Record<'mail' | 'calendar' | 'calendar_list' | 'tasks' | 'drive', boolean>>>;
  calendarIds?: readonly string[]; taskListIds?: readonly string[];
}>;
export type OwnerSourceInventoryCoverage = Readonly<{source:'calendar'|'tasks';accountId:string;collection:string|null;state:'partial'|'unavailable';reason:string}>;
export type OwnerProactivityDeps = Readonly<{
  purpose?: 'background'|'interactive';
  sql: Sql; book: ProactivityBook; updates: UpdateBook; loops: LoopBook; responsibilities: ResponsibilityBook; google: GoogleAccess;
  accounts(): Promise<readonly OwnerProactivityAccount[]>;
  assertOwnerCurrent(): Promise<void>; audience(): Promise<string>; timezone(): string; now(): number;
  transaction<T>(work: () => T): T;
  // The existing responder owns model/provider selection and composed owner context. These
  // calls are read-only judgment, with source taint and text capture disabled by that host.
  prompt(instruction: string, input: unknown, schema: object, current: () => Promise<void>): Promise<string>;
  push?: Readonly<{ gmailTopic?: string; calendarAddress?: string; calendarToken(witness: GoogleCalendarPushWitness): Promise<string> }>;
  enqueue(delivery: Delivery): Promise<Readonly<{ state: 'queued' | 'delivered' | 'blocked' | 'unknown'; receiptRef?: string; reason?: string }>>;
}>;
type Epoch = { revision: string; connected: boolean; epoch: number };
type Inventory = { revision: string; through: number; token: string | null; ids: readonly string[]; complete: boolean };
type Target = { refs: readonly SourceRef[]; signature: string; loop: Readonly<{ title: string; due: string | null }> };
type SourceSubscription = SourceKey & { epoch: number; regime: string; state: 'pending' | 'active' | 'unknown' | 'blocked'; id: string; resourceId: string | null; historyId: string | null; expiresAt: number; renewAt: number };
type SourceMaterial = { observation: Observation; value: unknown; handled: boolean; complete: boolean };
const DAY = 86_400_000, INVENTORY_TTL = 10 * 60_000;
const sourceId = (ref: Pick<SourceRef, 'source' | 'accountId' | 'collection' | 'resourceId'>) => JSON.stringify([ref.source, ref.accountId, ref.collection, ref.resourceId]);
const sourceKey = (ref: SourceKey) => JSON.stringify([ref.source, ref.accountId, ref.collection]);
const feature = (source: SourceKey): GoogleFeature => source.source === 'mail' ? 'mail' : source.source === 'tasks' ? 'tasks' : source.source === 'drive' ? 'drive' : 'calendar';
const cleanMessage = (message: ThreadMessage) => {
  const redacted = extractArtifactFields([message.subject, message.body]);
  return { ...message, subject: redacted.texts[0]!, body: redacted.texts[1]! };
};
const calendarValue = (event: CalendarItem) => ({ ...calendarPromptProjection(event), status: event.status ?? 'confirmed' });
const taskValue = (task: TaskItem) => ({ id: task.id, title: task.title, status: task.status, due: task.due?.slice(0, 10) ?? null, notes: task.notes ?? null, parent: task.parent ?? null, task_list_id: task.task_list_id ?? null });

// This is a serving adapter for the existing owner books, not a second planner or grant
// authority. Source bodies are held only for the current model invocation; durable custody
// contains references, account/grant epochs and the existing owner responsibility/outbox.
export function createOwnerProactivity(deps: OwnerProactivityDeps) {
  deps.sql.exec('CREATE TABLE IF NOT EXISTS owner_proactivity_adapter (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const adapterId = (id: string) => JSON.stringify([deps.book.ownerKey, id]);
  const synchronizePreferences = () => {
    const value = deps.loops.proactivity();
    deps.book.synchronizeOwnerPreferences({ timezone: deps.timezone(), volume: value.volume, followups: value.followups ?? true, quietHours: value.quiet_start && value.quiet_end ? { start: value.quiet_start, end: value.quiet_end } : null });
  };
  const read = <T>(id: string): T | null => {
    const row = deps.sql.exec<{ value: string }>('SELECT value FROM owner_proactivity_adapter WHERE id = ?', adapterId(id)).toArray()[0];
    return row ? JSON.parse(row.value) as T : null;
  };
  const put = (id: string, value: unknown) => deps.sql.exec('INSERT INTO owner_proactivity_adapter (id, value) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value', adapterId(id), JSON.stringify(value));
  const material = new Map<string, SourceMaterial>();
  const checks = new Map<string, readonly SourceMaterial[]>();
  let inventoryCoverage: OwnerSourceInventoryCoverage[] = [];
  const interactive = (purpose=deps.purpose??'background') => purpose==='interactive';
  let inventoryFailures: { stage: 'discovery'; id: string; code: string }[] = [];
  const account = async (id: string) => {
    await deps.assertOwnerCurrent();
    const rows = await deps.accounts();
    await deps.assertOwnerCurrent();
    if (new Set(rows.map(row => row.id)).size !== rows.length || rows.some(row => !row.id || !row.email || !row.revision)) throw new ProactivityConflict('invalid_input');
    return rows.find(row => row.id === id) ?? null;
  };
  const epoch = (id: string, row: OwnerProactivityAccount | null) => {
    const prior = read<Epoch>(`epoch:${id}`), connected = row?.connected === true, revision = row?.revision ?? 'disconnected';
    if (prior && prior.revision === revision && prior.connected === connected) return prior.epoch;
    const next = { revision, connected, epoch: (prior?.epoch ?? 0) + 1 }; put(`epoch:${id}`, next); return next.epoch;
  };
  const current = async (source: SourceKey, purpose:'background'|'interactive'=deps.purpose??'background') => {
    synchronizePreferences();
    const row = await account(source.accountId), accessEpoch = epoch(source.accountId, row);
    const inventory = source.source === 'calendar' || source.source === 'tasks' ? read<Inventory>(`inventory:${source.accountId}:${source.source}`) : null;
    const permitted = row?.connected === true && row.features[feature(source) as keyof OwnerProactivityAccount['features']] === true
      && (source.source !== 'calendar' || (row.calendarIds ? row.calendarIds.includes(source.collection) : !row.features.calendar_list ? source.collection==='primary' : inventory?.revision===row.revision && inventory.ids.includes(source.collection)))
      && (source.source !== 'tasks' || (row.taskListIds ? row.taskListIds.includes(source.collection) : inventory?.revision===row.revision && inventory.ids.includes(source.collection)));
    const sourceEpoch = epoch(`source:${sourceKey(source)}`, row ? { ...row, revision: `${accessEpoch}:${permitted}`, connected: permitted } : null);
    return { ownerKey: deps.book.ownerKey, epoch: sourceEpoch, connected: permitted, available: permitted && row?.available === true && (interactive(purpose)||deps.book.processingAllowed(source)), regime: interactive(purpose)?JSON.stringify(['interactive',row?.revision??'disconnected',sourceKey(source),sourceEpoch]):deps.book.processingRegime(source) };
  };
  const pinned = async (source: SourceKey): Promise<GoogleClient> => {
    const admission = await current(source);
    if (!admission.connected || !admission.available) throw new ProactivityConflict('source_revoked');
    const row = (await account(source.accountId))!;
    const guard = async () => {
      const latest = await current(source);
      if (!latest.available || latest.epoch !== admission.epoch || latest.regime !== admission.regime) throw new ProactivityConflict('source_revoked');
    };
    const client = await deps.google.client(feature(source), undefined, guard, row.email);
    await guard();
    if (!client || client.account?.connection_id !== row.id || client.account.email?.toLowerCase() !== row.email.toLowerCase()) throw new ProactivityConflict('source_revoked');
    // Guard each actual provider read as well as the host's proxy client acquisition.
    return new Proxy(client, { get(target, name) {
      const value = Reflect.get(target, name);
      return typeof value !== 'function' ? value : async (...args: unknown[]) => { await guard(); const result = await value.apply(target, args); await guard(); return result; };
    } });
  };
  const observe = async (source: SourceKey, resourceId: string, value: unknown, handled = false, complete = true, providerRevision?: string): Promise<SourceMaterial> => {
    const revision = providerRevision ?? await sha256Hex(JSON.stringify(value));
    const observation: Observation = { source: source.source, accountId: source.accountId, collection: source.collection, resourceId, revision, observedAt: deps.now(), deleted: handled, contentRef: sourceId({ ...source, resourceId }) };
    const result = { observation, value, handled, complete }; material.set(sourceId(observation), result); return result;
  };
  const thread = async (client: GoogleClient, id: string) => {
    if (!client.threadPage) throw new ProactivityConflict('not_available');
    const messages: ThreadMessage[] = [], seen = new Set<string>();
    let cursor: string | undefined, bodiesComplete=true,bodyPages=0;
    for (let page = 0; page < 20; page++) {
      const result = await client.threadPage(id, 20, cursor);
      for (const row of result.messages) {
        if (seen.has(row.id)) throw new ProactivityConflict('stale_source');seen.add(row.id);
        let value={...row},bodyCursor=row.body_cursor;
        while(bodyCursor&&client.messageBodyPage&&bodyPages<20){const part=await client.messageBodyPage(id,row.id,bodyCursor);bodyPages++;if(part.message.id!==row.id||part.body_offset!==value.body.length||part.next_cursor===bodyCursor)throw new ProactivityConflict('stale_source');value={...value,body:value.body+part.message.body,body_complete:part.next_cursor===null&&part.source_complete,body_cursor:part.next_cursor??undefined};bodyCursor=part.next_cursor??undefined;}
        if(value.body_complete===false||value.attachments_omitted===true||bodyCursor)bodiesComplete=false;
        messages.push(value);
      }
      if (!result.cursor) return { messages: messages.map(cleanMessage), complete: bodiesComplete };
      if (result.cursor === cursor) throw new ProactivityConflict('stale_source'); cursor = result.cursor;
    }
    return { messages: messages.map(cleanMessage), complete: false };
  };
  const collectionQuery = async (source: SourceKey, resourceId: string): Promise<SourceMaterial> => {
    const client = await pinned(source), values: unknown[] = [];
    let cursor: string | undefined;
    const window = source.source === 'calendar' ? resourceId.split(':').slice(1).map(Number) : null;
    if (window && (window.length !== 2 || window.some(value => !Number.isSafeInteger(value)) || window[0]! >= window[1]! || window[1]! - window[0]! > 90 * DAY)) throw new ProactivityConflict('invalid_input');
    for (let page = 0; page < 20; page++) {
      let next: string | null;
      if (source.source === 'calendar') {
        if (!client.calendarPage || !window) throw new ProactivityConflict('not_available');
        const result = await client.calendarPage(source.collection, new Date(window[0]!).toISOString(), new Date(window[1]!).toISOString(), 50, true, cursor);
        if (result.account.connection_id !== source.accountId) throw new ProactivityConflict('source_revoked');
        values.push(...result.events.map(calendarValue)); next = result.next_page_token;
      } else {
        if (!client.tasksPage) throw new ProactivityConflict('not_available');
        const result = await client.tasksPage(source.collection, 'all', 50, cursor);
        if (result.account.connection_id !== source.accountId || !result.task_list_ids.includes(source.collection)) throw new ProactivityConflict('source_revoked');
        values.push(...result.tasks.map(taskValue)); next = result.next_page_token;
      }
      if (!next) return observe(source, resourceId, { query: window ? { from: window[0], to: window[1] } : { status: 'all' }, values }, false, true);
      if (next === cursor) throw new ProactivityConflict('stale_source'); cursor = next;
    }
    // The explicit incomplete receipt prevents a partial read from establishing absence.
    return observe(source, resourceId, { query: window ? { from: window[0], to: window[1] } : { status: 'all' }, values, continuation: cursor }, false, false);
  };
  const readRef = async (ref: SourceRef): Promise<SourceMaterial | null> => {
    if (ref.source === 'calendar' && ref.resourceId.startsWith('calendar-window:') || ref.source === 'tasks' && ref.resourceId === 'tasks-collection') return collectionQuery(ref, ref.resourceId);
    const client = await pinned(ref);
    try {
      if (ref.source === 'mail') {
        const value = await thread(client, ref.resourceId);
        return value.messages.length ? observe(ref, ref.resourceId, value.messages, false, value.complete) : null;
      }
      if (ref.source === 'calendar') {
        if (!client.eventInCalendar) throw new ProactivityConflict('not_available');
        const value = await client.eventInCalendar(ref.collection, ref.resourceId);
        return observe(ref, ref.resourceId, calendarValue(value), value.status === 'cancelled');
      }
      if (ref.source === 'tasks') {
        if (!client.task) throw new ProactivityConflict('not_available');
        const value = await client.task(ref.collection, ref.resourceId);
        const normalized: TaskItem = { id: value.id, title: value.title, task_list_id: ref.collection, status: value.status, ...(value.notes !== null ? { notes: value.notes } : {}), ...(value.parent !== null ? { parent: value.parent } : {}), ...(value.due_date !== null ? { due: value.due_date } : {}) };
        return observe(ref, ref.resourceId, taskValue(normalized), value.status === 'done' || value.deleted === true);
      }
      if (ref.source === 'drive') {
        if (!client.driveGetFileMetadata || !client.driveReadFileContent) throw new ProactivityConflict('not_available');
        const meta = await client.driveGetFileMetadata({ fileId: ref.resourceId });
        if (!meta.modifiedTime) return null;
        const value = await client.driveReadFileContent({ fileId: ref.resourceId, expectedModifiedTime: meta.modifiedTime });
        return observe(ref, ref.resourceId, { file: value.file, text: extractArtifacts(value.text).text, version: value.version }, false, !value.truncated, meta.modifiedTime);
      }
    } catch (error) {
      // A provider-confirmed disappearance invalidates a hypothesis; a failed or denied read
      // cannot establish completion or absence.
      if (error instanceof GoogleError && (error.status === 404 || error.status === 410)) return null;
      throw error;
    }
    throw new ProactivityConflict('not_available');
  };
  const inventories = async (row: OwnerProactivityAccount, kind: 'calendar' | 'tasks', purpose:'background'|'interactive'): Promise<readonly string[]> => {
    const regime = interactive(purpose)?row.revision:deps.book.accountProcessingRegime(row.id);
    const guard = async () => {
      await deps.assertOwnerCurrent(); synchronizePreferences();
      const latest = await account(row.id);
      if (!latest?.connected || !latest.available || latest.revision !== row.revision || !interactive(purpose)&&(!deps.book.accountProcessingAllowed(row.id) || deps.book.accountProcessingRegime(row.id) !== regime)) throw new ProactivityConflict('source_revoked');
    };
    await guard();
    const explicit = kind === 'calendar' ? row.calendarIds : row.taskListIds;
    if (explicit) return explicit;
    if (kind === 'calendar' && !row.features.calendar_list) return ['primary'];
    const id = `inventory:${row.id}:${kind}`, old = read<Inventory>(id);
    if (old && old.revision===row.revision && old.through>deps.now()-INVENTORY_TTL && (old.complete||interactive(purpose))) {
      if(!old.complete)inventoryCoverage.push({source:kind,accountId:row.id,collection:null,state:'partial',reason:'collection_inventory_incomplete'});
      return old.ids;
    }
    let state: Inventory = old && !old.complete && old.revision === row.revision ? old : { revision: row.revision, through: deps.now(), token: null, ids: [], complete: false };
    const client = await deps.google.client(kind === 'calendar' ? 'calendar_list' : 'tasks', undefined, guard, row.email);
    await guard();
    if (!client || client.account?.connection_id !== row.id || client.account.email?.toLowerCase() !== row.email.toLowerCase()) throw new ProactivityConflict('source_revoked');
    for (let page = 0; page < 4; page++) {
      await guard();
      const value = kind === 'calendar' ? await client.calendarListsPage?.(100, true, state.token ?? undefined) : await client.taskListsPage?.(100, state.token ?? undefined);
      await guard();
      if (!value || value.account.connection_id !== row.id || value.account.email?.toLowerCase() !== row.email.toLowerCase() || value.next_page_token && value.next_page_token === state.token) throw new ProactivityConflict('source_revoked');
      state = { ...state, through:deps.now(), ids: [...new Set([...state.ids, ...value.items.map(item => item.id)])], token: value.next_page_token, complete: value.next_page_token === null };
      put(id, state); if (state.complete) return state.ids;
    }
    inventoryCoverage.push({source:kind,accountId:row.id,collection:null,state:'partial',reason:'collection_inventory_incomplete'});
    return interactive(purpose)?state.ids:[]; // Known collections can serve a manual read; no partial inventory establishes absence.
  };
  const sources = async (purpose:'background'|'interactive'=deps.purpose??'background'): Promise<readonly SourceKey[]> => {
    synchronizePreferences();
    await deps.assertOwnerCurrent(); const rows = await deps.accounts(); await deps.assertOwnerCurrent();
    inventoryFailures = []; inventoryCoverage=[];
    const values: SourceKey[] = [];
    for (const row of rows) {
      epoch(row.id, row);
      if (!interactive(purpose)&&!deps.book.discoveryAllowed()) continue;
      for (const kind of ['calendar', 'tasks'] as const) {
        if (!row.connected||!row.available||!row.features[kind]) {
          if (interactive(purpose)) {const known=kind==='calendar'?row.calendarIds:row.taskListIds;for(const collection of known?.length?known:[null])inventoryCoverage.push({source:kind,accountId:row.id,collection,state:'unavailable',reason:!row.connected?'account_disconnected':!row.available?'account_unavailable':'grant_not_permitted'});}
          continue;
        }
        if (!interactive(purpose)&&!deps.book.accountProcessingAllowed(row.id)) continue;
        try { for (const id of await inventories(row, kind, purpose)) values.push({ source: kind, accountId: row.id, collection: id }); }
        catch { await deps.assertOwnerCurrent(); inventoryFailures.push({ stage: 'discovery', id: JSON.stringify([row.id, kind]), code: 'inventory_unavailable' });inventoryCoverage.push({source:kind,accountId:row.id,collection:null,state:'unavailable',reason:'collection_inventory_unavailable'}); }
      }
      if(!row.connected||!row.available)continue;
      if (row.features.drive && (interactive(purpose)||deps.book.processingAllowed({ source: 'drive', accountId: row.id, collection: 'files' }))) values.push({ source: 'drive', accountId: row.id, collection: 'files' });
      if (row.features.mail && (interactive(purpose)||deps.book.processingAllowed({ source: 'mail', accountId: row.id, collection: 'inbox' }))) values.push({ source: 'mail', accountId: row.id, collection: 'inbox' });
    }
    for (const source of deps.book.sourceAccess()) {
      const admission = await current(source,'background'); deps.book.setSourceAccess({ ...source, ...admission });
    }
    // Read context-producing collections before the general inbox sweep, so discovery can
    // compare actual Calendar/Tasks coverage without assuming the default account.
    return [...values.filter(value => value.source !== 'mail'), ...values.filter(value => value.source === 'mail')];
  };
  const reconcileWatchLifecycle = () => {
    deps.transaction(() => {
      for (const watch of deps.book.watches()) {
        if (!['active', 'paused'].includes(watch.state)) continue;
        const responsibility = deps.responsibilities.get(watch.responsibilityId);
        const loop = deps.sql.exec<{ title: string; due: string | null; status: string }>('SELECT title, due, status FROM loops WHERE id = ?', watch.responsibilityId).toArray()[0];
        const target = read<Target>(`target:${watch.id}`);
        if (!responsibility || !loop || ['done', 'dropped'].includes(responsibility.status) || loop.status !== 'open') {
          // Only the existing authority's closure evidence can satisfy work. A removed or
          // legacy closed loop cancels checking without inventing a completion receipt.
          const evidence = responsibility?.closed_by_evidence;
          deps.book.controlWatch(watch.id, watch.revision, evidence ? 'complete' : 'cancel', evidence ?? 'responsibility_closed');
        } else if (watch.state === 'active' && target && (watch.responsibilityRevision !== responsibility.revision || target.loop.title !== loop.title || target.loop.due !== loop.due)) {
          const due = loop.due === null ? deps.now() : localToEpoch(loop.due, deps.timezone());
          deps.book.reviseWatch(watch.id, watch.revision, { responsibilityRevision: responsibility.revision, audience: watch.audience, condition: watch.condition, nextCheckAt: Math.max(deps.now(), due), expiresAt: watch.expiresAt });
          put(`target:${watch.id}`, { ...target, loop: { title: loop.title, due: loop.due } });
        }
      }
    });
  };
  const subscriptions = () => read<readonly SourceSubscription[]>('subscriptions') ?? [];
  const saveSubscription = (row: SourceSubscription) => put('subscriptions', [...subscriptions().filter(old => old.expiresAt > deps.now() && old.id !== row.id), row]);
  const pushAvailability = () => ({ mail: deps.push?.gmailTopic ? 'configured' as const : 'unavailable' as const,
    calendar: deps.push?.calendarAddress && validGooglePushAddress(deps.push.calendarAddress) ? 'configured' as const : 'unavailable' as const,
    delivery: 'provider_registration_and_authenticated_ingress_required' as const });
  const maintainPush = async (active: readonly SourceKey[]) => {
    const failures: { stage: 'discovery'; id: string; code: string }[] = [];
    if (!deps.push) return failures;
    let registrations = 0;
    for (const source of active.filter(row => row.source === 'mail' || row.source === 'calendar')) {
      if (registrations >= 4 || !deps.book.processingAllowed(source)) continue;
      const admission = await current(source);
      if (!admission.available) continue;
      const prior = subscriptions().filter(row => sourceKey(row) === sourceKey(source) && row.epoch === admission.epoch && row.expiresAt > deps.now()).at(-1);
      if (prior && (prior.state === 'unknown' || prior.state === 'pending' || prior.state === 'active' && prior.renewAt > deps.now())) continue;
      if (source.source === 'mail' && !deps.push.gmailTopic || source.source === 'calendar' && (!deps.push.calendarAddress || !validGooglePushAddress(deps.push.calendarAddress))) {
        failures.push({stage:'discovery', id:sourceKey(source), code:'source_push_unavailable'}); continue;
      }
      // Persist the operation identity before dispatch. An interrupted Calendar registration
      // remains unknown until its requested expiration; it never creates another channel.
      const id = await sha256Hex(JSON.stringify([deps.book.ownerKey, sourceKey(source), admission.epoch, deps.now()]));
      const requested = deps.now() + 2 * DAY;
      const pending: SourceSubscription = {...source, epoch:admission.epoch, regime:admission.regime, id, resourceId:null, historyId:null, expiresAt:requested, renewAt:deps.now() + DAY, state:'pending'};
      saveSubscription(pending); registrations++;
      try {
        const client = await pinned(source);
        let result: SourceSubscription;
        if (source.source === 'mail') {
          if (!client.watchMail) throw new ProactivityConflict('not_available');
          const receipt = await client.watchMail(deps.push.gmailTopic!);
          result = {...pending, state:'active', historyId:receipt.historyId, expiresAt:receipt.expiration, renewAt:Math.min(deps.now()+DAY, receipt.expiration-60_000)};
        } else {
          if (!client.watchCalendarEvents) throw new ProactivityConflict('not_available');
          const witness = {ownerKey:deps.book.ownerKey, connectionId:source.accountId, calendarId:source.collection, channelId:id, epoch:admission.epoch};
          const token = await deps.push.calendarToken(witness);
          const receipt = await client.watchCalendarEvents(source.collection, {id, address:deps.push.calendarAddress!, token, expiration:requested});
          result = {...pending, state:'active', resourceId:receipt.resourceId, expiresAt:receipt.expiration, renewAt:Math.max(deps.now()+60_000, receipt.expiration-Math.min(DAY, Math.floor((receipt.expiration-deps.now())/2)))};
        }
        const latest = await current(source);
        if (!latest.available || latest.epoch !== admission.epoch || latest.regime !== admission.regime) {
          saveSubscription({...result, state:'blocked'}); throw new ProactivityConflict('source_revoked');
        }
        saveSubscription(result);
      } catch (error) {
        if (subscriptions().find(row => row.id === id)?.state === 'pending') saveSubscription({...pending, state:'unknown'});
        failures.push({stage:'discovery', id:sourceKey(source), code:error instanceof ProactivityConflict ? error.code : 'source_push_outcome_unknown'});
      }
    }
    return failures;
  };
  const wakeSource = async (source: SourceKey, expectedEpoch: number, eventKey: string) => {
    const latest = await current(source);
    if (!latest.available || latest.epoch !== expectedEpoch) return 0;
    deps.book.setSourceAccess({...source, ...latest});
    let count = 0;
    for (const watch of deps.book.watches()) if (watch.state === 'active' && watch.sources.some(row => sourceKey(row) === sourceKey(source) && row.epoch === expectedEpoch)) {
      if (deps.book.wake(watch.id, eventKey, deps.now())) count++;
    }
    return count;
  };
  const ports: ProactivityPorts = {
    now: deps.now,
    admit: source=>current(source,'background'),
    async fetchPage(sweep) {
      const client = await pinned(sweep), observations: Observation[] = [];
      let token: string | null;
      if (sweep.source === 'mail') {
        const page = await client.mailPage('in:inbox', 20, sweep.pageToken ?? undefined); token = page.next_page_token;
        for (const id of new Set(page.messages.map(item => item.thread_id || item.id))) {
          const value = await thread(client, id);
          if (value.messages.length) observations.push((await observe(sweep, id, value.messages, false, value.complete)).observation);
        }
      } else if (sweep.source === 'calendar') {
        if (!client.calendarPage) throw new ProactivityConflict('not_available');
        const page = await client.calendarPage(sweep.collection, new Date(sweep.startedAt - 7 * DAY).toISOString(), new Date(sweep.startedAt + 60 * DAY).toISOString(), 50, true, sweep.pageToken ?? undefined);
        if (page.account.connection_id !== sweep.accountId) throw new ProactivityConflict('source_revoked'); token = page.next_page_token;
        for (const item of page.events) observations.push((await observe(sweep, item.id, calendarValue(item), item.status === 'cancelled')).observation);
      } else if (sweep.source === 'tasks') {
        if (!client.tasksPage) throw new ProactivityConflict('not_available');
        const page = await client.tasksPage(sweep.collection, 'all', 50, sweep.pageToken ?? undefined);
        if (page.account.connection_id !== sweep.accountId || !page.task_list_ids.includes(sweep.collection)) throw new ProactivityConflict('source_revoked'); token = page.next_page_token;
        for (const item of page.tasks) observations.push((await observe(sweep, item.id, taskValue(item), item.status === 'done')).observation);
      } else if (sweep.source === 'drive') {
        if (!client.driveListFiles) throw new ProactivityConflict('not_available');
        const page = await client.driveListFiles({ pageSize: 20, ...(sweep.pageToken ? { pageToken: sweep.pageToken } : {}) });
        if (page.incompleteSearch) throw new ProactivityConflict('not_available'); token = page.nextPageToken;
        for (const item of page.files) observations.push((await observe(sweep, item.id, item, false, false, item.modifiedTime ?? undefined)).observation);
      } else throw new ProactivityConflict('not_available');
      return { observations, nextPageToken: token, nextCursor: token ? null : String(sweep.startedAt) };
    },
    async discovered(coverage, observations) {
      const relevant = observations.filter(row => !row.deleted && read<string>(`discovered:${coverage.epoch}:${sourceId(row)}`) !== row.revision);
      // Apply only bounded model work; the remaining references stay in the observation book
      // and are selected on the next completed sweep, including after process eviction.
      const selected: SourceMaterial[] = [];
      for (const row of relevant.slice(0, 12)) {
        const cached = material.get(sourceId(row)), value = cached?.complete ? cached : await readRef(row);
        if (value && value.complete && !value.handled) selected.push(value);
      }
      if (!selected.length) return;
      const related: SourceMaterial[] = [];
      const companions = coverage.source === 'mail' ? deps.book.sourceAccess().filter(row => row.connected && (row.source === 'calendar' || row.source === 'tasks')) : [];
      for (const source of companions.slice(0, 16)) {
        if (!deps.book.processingAllowed(source)) continue;
        const id = source.source === 'calendar' ? `calendar-window:${deps.now() - 7 * DAY}:${deps.now() + 60 * DAY}` : 'tasks-collection';
        try { related.push(await collectionQuery(source, id)); }
        catch { await deps.assertOwnerCurrent(); }
      }
      const audience = await deps.audience(); await deps.assertOwnerCurrent();
      const admitted = await Promise.all([...new Map([...selected, ...related.filter(value => value.complete)].map(value => [sourceKey(value.observation), value.observation])).values()].map(async source => ({ source, admission: await current(source) })));
      const assertDiscoveryCurrent = async () => {
        await deps.assertOwnerCurrent();
        if (await deps.audience() !== audience) throw new ProactivityConflict('source_revoked');
        for (const { source, admission } of admitted) {
          const latest = await current(source);
          deps.book.setSourceAccess({ ...source, ...latest });
          if (!admission.available || !latest.available || latest.epoch !== admission.epoch || latest.regime !== admission.regime
            || sourceKey(source) === sourceKey(coverage) && latest.epoch !== coverage.epoch) throw new ProactivityConflict('source_revoked');
        }
        await deps.assertOwnerCurrent();
      };
      await assertDiscoveryCurrent();
      const judgmentAt = deps.now();
      const sourceResponsibilities = new Set(deps.book.watches().map(watch => watch.responsibilityId));
      const currentSourceResponsibilities = new Set(deps.book.watches().filter(watch => ['active', 'paused'].includes(watch.state)
        && watch.sources.every(source => { const access = deps.book.access(source); return access?.connected && access.epoch === source.epoch; })).map(watch => watch.responsibilityId));
      // Retained source-recovery identities are not active personalization after disconnect.
      // Owner-authored responsibilities remain available under their existing authority.
      const responsibilities = deps.responsibilities.all().filter(row => !sourceResponsibilities.has(row.id) || currentSourceResponsibilities.has(row.id));
      const raw = await deps.prompt(PROACTIVITY_DISCOVERY_INSTRUCTION, {
        owner_audience: audience, now: judgmentAt, timezone: deps.timezone(), source_coverage: coverage,
        sources: selected.map(value => ({ source_ref: sourceId(value.observation), ref: value.observation, full_current_source: value.value })),
        responsibilities,
        related_current_sources: related.map(value => ({ source_ref: sourceId(value.observation), ref: value.observation, coverage: value.complete ? 'complete' : 'partial', value: value.value })),
        omitted_related_collections: companions.length - related.filter(value => value.complete).length,
        coverage_note: 'Calendar queries cover their exact frozen bounds. Other collections are paged baselines. Incomplete, omitted or failed related collections never establish absence. Companion Calendar and Tasks query revisions are frozen with the hypothesis and rechecked before delivery.',
      }, PROACTIVITY_DISCOVERY_SCHEMA, assertDiscoveryCurrent);
      await assertDiscoveryCurrent();
      const known = new Map([...selected, ...related.filter(value => value.complete)].map(value => [sourceId(value.observation), value]));
      const candidates = parseDiscoveryCandidates(raw, new Set(known.keys()), judgmentAt);
      for (const value of known.values()) {
        const latest = await readRef(value.observation);
        if (!latest || !latest.complete || latest.observation.revision !== value.observation.revision) throw new ProactivityConflict('stale_source');
      }
      await assertDiscoveryCurrent();
      const prepared = await Promise.all(candidates.map(async candidate => {
        const primaryRefs = candidate.source_refs.map(id => known.get(id)!.observation);
        const refs = [...new Map([...primaryRefs, ...(primaryRefs.some(ref => ref.source === 'mail') ? related.filter(value => value.complete).map(value => value.observation) : [])].map(ref => [sourceId(ref), ref])).values()];
        const signature = JSON.stringify(primaryRefs.map(ref => JSON.stringify([sourceId(ref.source === 'calendar' && ref.resourceId.startsWith('calendar-window:') ? { ...ref, resourceId: 'calendar-window' } : ref), deps.book.access(ref)?.epoch])).sort());
        return { candidate, primary: primaryRefs[0]!, refs, signature, sourceRef: `proactivity:${await sha256Hex(sourceId(primaryRefs[0]!))}` };
      }));
      await assertDiscoveryCurrent();
      deps.transaction(() => {
        deps.book.observeFresh([...known.values()].map(value => value.observation));
        for (const { candidate, primary, refs, signature, sourceRef } of prepared) {
          if (read<string>(`candidate:${signature}`)) continue;
          // Generic source references keep Calendar/Tasks distinct from observed Gmail and
          // prevent the deterministic heartbeat from bypassing fresh-source checking.
          if (primary.source === 'mail') {
            const messages = known.get(sourceId(primary))!.value as readonly ThreadMessage[];
            const latest = messages.at(-1)!;
            deps.updates.observeMail(sourceRef, primary.resourceId, deps.now(), latest.id);
            deps.updates.record(localIso(deps.now(), deps.timezone()).slice(0, 10), deps.now(), [{ source: 'mail', kind: 'new', detail: 'Current source-backed follow-through hypothesis; reopen the thread for full context.', source_ref: sourceRef, source_message_id: latest.id, account_id: primary.accountId }], null);
          } else deps.loops.observeSource({ sourceRef, family: primary.source, accountId: primary.accountId, resourceId: primary.resourceId, revision: primary.revision, observedAt: deps.now() });
          const loop = deps.loops.list().find(row => row.source_ref === sourceRef) ?? deps.loops.open({ title: candidate.title, due: localIso(candidate.check_at, deps.timezone()).slice(0, 16), source_ref: sourceRef });
          deps.loops.manageSourceReview(loop.id);
          deps.responsibilities.adoptLoops(id => id === loop.id ? candidate.hypothesis : null); const responsibility = deps.responsibilities.get(loop.id)!;
          const distinct = [...new Map(refs.map(ref => [sourceKey(ref), { source: ref.source, accountId: ref.accountId, collection: ref.collection, epoch: deps.book.access(ref)!.epoch }])).values()];
          const watch = deps.book.createWatch({ responsibilityId: responsibility.id, responsibilityRevision: responsibility.revision, sources: distinct, audience, condition: { kind: 'source_change', resourceIds: refs.map(ref => ref.resourceId) }, nextCheckAt: Math.max(deps.now(), candidate.check_at), expiresAt: null, subscription: null });
          put(`target:${watch.id}`, { refs, signature, loop: { title: loop.title, due: loop.due } } satisfies Target); put(`candidate:${signature}`, watch.id);
        }
        for (const value of selected) put(`discovered:${coverage.epoch}:${sourceId(value.observation)}`, value.observation.revision);
      });
    },
    async checkCurrent(watch) {
      await deps.assertOwnerCurrent(); const target = read<Target>(`target:${watch.id}`), responsibility = deps.responsibilities.get(watch.responsibilityId), audience = await deps.audience();
      const loop = deps.sql.exec<{ title: string; due: string | null; status: string }>('SELECT title, due, status FROM loops WHERE id = ?', watch.responsibilityId).toArray()[0];
      const values: SourceMaterial[] = [];
      for (const ref of target?.refs ?? []) { const value = await readRef(ref); if (value) values.push(value); }
      await deps.assertOwnerCurrent(); checks.set(watch.id, values);
      return { observations: values.map(value => value.observation), check: {
        refs: values.map(value => value.observation), checkedAt: deps.now(), coverage: target && values.length === target.refs.length && values.every(value => value.complete) ? 'complete' : 'partial',
        status: responsibility && ['done', 'dropped'].includes(responsibility.status) || loop && loop.status !== 'open' || values.some(value => value.handled) ? 'handled' : !responsibility || !target || values.length !== target.refs.length ? 'unknown' : 'open',
        evidenceRefs: values.filter(value => value.complete).map(value => `provider-read:${sourceId(value.observation)}:${value.observation.revision}`), responsibilityRevision: loop && target && loop.title === target.loop.title && loop.due === target.loop.due ? responsibility?.revision ?? 0 : 0, audience,
      } };
    },
    async decide(watch, check) {
      const duplicates = deps.book.deliveries().filter(row => row.watchId === watch.id && row.watchRevision === watch.revision && !['blocked', 'silent'].includes(row.state) && row.refs.length === check.refs.length && row.refs.every(ref => check.refs.some(current => sourceId(current) === sourceId(ref) && current.revision === ref.revision)));
      if (watch.condition.kind === 'source_change' && duplicates.length) return { disposition: 'silent', rationale: 'This unchanged source occurrence already has durable delivery custody.', text: '' };
      const decisionRegimes = new Map(watch.sources.map(source => [sourceKey(source), deps.book.processingRegime(source)]));
      const assertDecisionCurrent = async () => {
        await deps.assertOwnerCurrent();
        const latestWatch = deps.book.watch(watch.id), responsibility = deps.responsibilities.get(watch.responsibilityId);
        const loop = deps.sql.exec<{ title: string; due: string | null; status: string }>('SELECT title, due, status FROM loops WHERE id = ?', watch.responsibilityId).toArray()[0];
        const target = read<Target>(`target:${watch.id}`);
        if (!latestWatch || latestWatch.state !== 'active' || latestWatch.revision !== watch.revision
          || await deps.audience() !== watch.audience || responsibility?.revision !== watch.responsibilityRevision
          || !['open', 'waiting', 'uncertain'].includes(responsibility.status) || !loop || loop.status !== 'open' || !target
          || loop.title !== target.loop.title || loop.due !== target.loop.due) throw new ProactivityConflict('source_revoked');
        for (const source of watch.sources) {
          const latest = await current(source);
          deps.book.setSourceAccess({ ...source, ...latest });
          if (!latest.available || latest.epoch !== source.epoch || latest.regime !== decisionRegimes.get(sourceKey(source))) throw new ProactivityConflict('source_revoked');
        }
        await deps.assertOwnerCurrent();
      };
      await assertDecisionCurrent();
      const raw = await deps.prompt(PROACTIVITY_DECISION_INSTRUCTION, { watch, check, responsibility: deps.responsibilities.get(watch.responsibilityId), full_current_sources: (checks.get(watch.id) ?? []).map(value => ({ ref: value.observation, value: value.value })), policy: deps.book.policy(), source_policies: watch.sources.map(source => ({ source, policy: deps.book.sourcePolicy(source) })), previous_deliveries: deps.book.deliveries().filter(row => row.watchId === watch.id).map(row => ({ disposition: row.disposition, state: row.state, createdAt: row.createdAt })) }, PROACTIVITY_DECISION_SCHEMA, assertDecisionCurrent);
      await assertDecisionCurrent(); return parseProactiveDecision(raw);
    },
    async enqueue(delivery) {
      if (!await proactivityDeliveryEligible(deps.book, ports, delivery.id)) return { state: 'blocked', reason: 'current_source_or_audience_changed' };
      return deps.enqueue(delivery);
    },
  };
  return {
    ports, sources, pushAvailability,
    interactiveSources:()=>sources('interactive'),
    interactiveAdmit:(source:SourceKey)=>current(source,'interactive'),
    inventoryCoverage:()=>inventoryCoverage.map(row=>({...row})),
    // These are internal host ports. Gmail caller admission must already verify Pub/Sub OIDC
    // audience/service account/subscription; Calendar must already verify its opaque MAC.
    async calendarPush(witness: GoogleCalendarPushWitness, headers: Headers) {
      if (witness.ownerKey !== deps.book.ownerKey) return {accepted:false, wakes:0};
      const row = subscriptions().find(value => value.id === witness.channelId && value.source === 'calendar' && value.accountId === witness.connectionId && value.collection === witness.calendarId && value.epoch === witness.epoch && value.state === 'active' && value.resourceId);
      if (!row) return {accepted:false, wakes:0};
      const event = googleCalendarPushEvent(headers, {id:row.id, resourceId:row.resourceId!, expiration:row.expiresAt} satisfies GoogleCalendarWatch, deps.now());
      if (!event) return {accepted:false, wakes:0};
      const wakes = await wakeSource(row, row.epoch, event.eventKey);
      return {accepted:true, wakes};
    },
    async gmailPush(notice: Readonly<{connectionId:string; email:string; historyId:string; eventId:string}>) {
      if (!/^\d{1,30}$/.test(notice.historyId) || !notice.eventId || notice.eventId.length > 200) return {accepted:false, wakes:0};
      const ownerAccount = await account(notice.connectionId);
      if (!ownerAccount || ownerAccount.email.toLowerCase() !== notice.email.toLowerCase()) return {accepted:false, wakes:0};
      const row = subscriptions().filter(value => value.source === 'mail' && value.accountId === notice.connectionId && value.collection === 'inbox' && value.state === 'active' && value.expiresAt > deps.now()).at(-1);
      if (!row) return {accepted:false, wakes:0};
      const latest = await current(row);
      if (!latest.available || latest.epoch !== row.epoch) return {accepted:false, wakes:0};
      return {accepted:true, wakes:await wakeSource(row, row.epoch, `gmail-push:${notice.eventId}:${notice.historyId}`)};
    },
    control: { async set(args: SetProactivityArgs) {
      await deps.assertOwnerCurrent(); synchronizePreferences();
      const target = args.target ?? { scope: 'owner' as const };
      let source: SourceKey | undefined;
      if (target.scope !== 'owner') {
        const row = await account(target.account_id);
        if (!row?.connected) throw new ProactivityConflict('source_revoked');
        if (target.scope === 'collection') {
          source = { source: target.source, accountId: target.account_id, collection: target.collection };
          const known = deps.book.sourceAccess().some(value => sourceKey(value) === sourceKey(source!));
          const explicit = target.source === 'calendar' ? row.calendarIds?.includes(target.collection) : target.source === 'tasks' ? row.taskListIds?.includes(target.collection) : target.source === 'mail' ? target.collection === 'inbox' : target.collection === 'files';
          if (!known && !explicit || !row.features[feature(source) as keyof OwnerProactivityAccount['features']]) throw new ProactivityConflict('not_available');
        }
      }
      const prior = target.scope === 'owner' ? deps.book.policy() : target.scope === 'account' ? deps.book.accountPolicy(target.account_id) : deps.book.sourcePolicy(source!);
      if (args.policy_revision !== undefined && args.policy_revision !== prior.revision) throw new ProactivityConflict('stale_revision');
      const next = { ...prior, timezone: deps.timezone(), volume: args.volume, followups: args.followups ?? prior.followups ?? true,
        quietHours: args.quiet_start && args.quiet_end ? { start: args.quiet_start, end: args.quiet_end } : null,
        processingWindows: args.processing_windows ?? prior.processingWindows, notificationWindows: args.notification_windows ?? prior.notificationWindows };
      await deps.assertOwnerCurrent();
      const applied = target.scope === 'account' ? deps.book.updateAccountPolicy(target.account_id, prior.revision, next) : deps.book.updatePolicy(prior.revision, next, source);
      return { target, ...applied };
    } },
    async tick(options: Parameters<typeof runProactivityCycle>[3] = {}) {
      if(interactive())throw new ProactivityConflict('not_available');
      material.clear(); checks.clear();
      await deps.assertOwnerCurrent(); reconcileWatchLifecycle();
      const active = await sources();
      const collectionFailures: { stage: 'discovery'; id: string; code: string }[] = [];
      // Keep the existing update-card continuation and source-linked Gmail lane usable.
      for (const source of active.filter(value => value.source === 'calendar' || value.source === 'mail')) {
        if (!deps.book.processingAllowed(source)) continue;
        try {
          const client = await pinned(source);
          const changes = await collectChanges(deps.updates, client, deps.now(), true, { accountId: source.accountId, calendarId: source.source === 'calendar' ? source.collection : 'primary', calendar: source.source === 'calendar', mail: source.source === 'mail' });
          if (changes.length) deps.updates.record(localIso(deps.now(), deps.timezone()).slice(0, 10), deps.now(), changes, null);
        } catch { collectionFailures.push({ stage: 'discovery', id: sourceKey(source), code: 'provider_unavailable' }); }
      }
      const result = await runProactivityCycle(deps.book, ports, active, options);
      const pushFailures = await maintainPush(active);
      return { ...result, failures: [...inventoryFailures, ...collectionFailures, ...result.failures, ...pushFailures] };
    },
    recover() { deps.book.recover(); for (const row of subscriptions()) if (row.state === 'pending') saveSubscription({...row, state:'unknown'}); material.clear(); checks.clear(); },
    nextWakeAt(): number | null {
      synchronizePreferences();
      if (!deps.book.policy().enabled || deps.book.policy().followups === false) return null;
      const due = [deps.now() + 10 * 60_000,
        ...subscriptions().filter(row => row.state === 'active' && row.renewAt > deps.now()).map(row => row.renewAt),
        ...deps.book.watches().filter(row => row.state === 'active' && row.nextCheckAt > deps.now()).map(row => row.nextCheckAt),
        ...deps.book.deliveries().filter(row => (row.state === 'held' || row.state === 'pending') && row.eligibleAt > deps.now()).map(row => row.eligibleAt)];
      return Math.max(deps.now() + 60_000, Math.min(...due));
    },
    deliveryEligible: (id: string) => { synchronizePreferences(); return proactivityDeliveryEligible(deps.book, ports, id); },
    settle: (id: string, result: Parameters<ProactivityBook['settleDelivery']>[1]) => deps.book.settleDelivery(id, result),
  };
}
export type OwnerProactivity = ReturnType<typeof createOwnerProactivity>;
