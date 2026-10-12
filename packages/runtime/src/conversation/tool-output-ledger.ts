import { carriesTopic, hidesTopic } from '../memory/forget-guard';
import type { RunEffectScope } from '../channels/run-effect-scope';
import { asciiLiteralIncludes, forgetSourceBatch } from '../memory/selective-forget';
// Recent tool outputs as composable context (BUILD_ORDER 12). The tool loop's outputs
// used to live only inside one turn; this ledger keeps the last few so the context
// composer can stage them as tool_result sources with provenance and taint.
import type { ContextFragment } from '../context-composer/types';
import { approvalIdV1Schema, literalJsonTextRedactor, type SourceTaint } from '@waldo/contracts';
import { prepareWithScribe, type StrictSchema } from '../scribe/prepare';

export type ToolOutputEntry = Readonly<{
  tool: string;
  ok: boolean;
  at: number;
  // The producing tool's own taint. Admission and staging treat every row as external data whatever it is; a row
  // without one counts as external.
  taint: SourceTaint;
  // 'owner' when the owner's own turn produced the output. A row stored before origins were kept is never the owner's.
  origin?: 'owner' | 'machine';
  summary: string;
  // The approval a proposing tool's output names, read from the full output before the summary is cut: '' when the row
  // is withheld, null when the tool proposed nothing. Absent on other tools' rows and on rows stored before it was kept.
  proposal_ref?: string | null;
}>;

// The approval desk's current state for one approval, or null when it holds none by that id.
export type ProposalState = (id: string) => Promise<Readonly<{ kind: string; state: string }> | null>;

// The tools whose output reports an approval on the desk, and the field that names it. No other tool's output links.
const APPROVAL_FIELD: Readonly<Record<string, string>> = {
  send_email: 'proposal_id', send_message: 'proposal_id', propose_calendar_change: 'proposal_id', call_mcp_tool: 'proposal_id',
  browse_act: 'proposal_id', propose_google_task_change: 'approval_ref', raise_approval: 'approval_id',
};

// The approval a proposing tool's output names; '' when the output can't be read or names a malformed id, so the row is
// withheld; null when it names none. A raise_approval list names none but is the desk as it was, so it is withheld too.
const linkOf = (tool: string, output: string): string | null | undefined => {
  const field = APPROVAL_FIELD[tool];
  if (field === undefined) return undefined;
  let data: unknown;
  // The tool loop can append a note after the result's JSON.
  try { data = (JSON.parse(output.slice(0, output.lastIndexOf('}') + 1)) as { data?: unknown } | null)?.data; } catch { return ''; }
  const id = data !== null && typeof data === 'object' ? (data as Record<string, unknown>)[field] : undefined;
  if (id === undefined) return tool === 'raise_approval' && data !== undefined ? '' : null;
  return approvalIdV1Schema.safeParse(id).success ? id as string : '';
};

const MAX_KEPT = 6;
const MAX_SUMMARY_CHARS = 500;

type KeyValueStorage = {
  kv?: Pick<DurableObjectStorage['kv'], 'put' | 'delete'> & Partial<Pick<DurableObjectStorage['kv'], 'list'>>;
  get<T>(key: string): Promise<T | undefined>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
  put(entries: Record<string, unknown>): Promise<void>;
  delete(keys: string[]): Promise<unknown>;
};

const entryKey = (seq: number) => `toolout:${String(seq).padStart(10, '0')}`;

const summaryAdmissionSchema: StrictSchema<string> = {
  safeParse(value) {
    return typeof value === 'string' ? { success: true, data: value } : { success: false };
  },
};

// Tool-output summaries are staged into later turns. Reject fence closers, injected
// instructions, and structured secrets before persistence so a poisoned ring cannot
// fail every subsequent turn. Exact session canaries are checked when context is read;
// they are not known at ledger-write time.
const admitsForPrompt = (summary: string, taint: SourceTaint): boolean => {
  // The exact-canary check is turn-scoped and meaningless here (the real tokens do not exist
  // yet), but the contract schema requires exactly 3 distinct 16-hex tokens. Random throwaway
  // tokens satisfy the schema with no false-positive risk (48 hex chars of entropy per call)
  // while fence/instruction/secret guards run at this turn-independent boundary. The payload must survive unrewritten: a fragment the scribe
  // would transform on its way to the canvas is staged differently than what was recorded.
  const throwawayCanaries = Array.from({ length: 3 }, () => crypto.randomUUID().replaceAll('-', '').slice(0, 16));
  const prepared = prepareWithScribe(summary, summaryAdmissionSchema, 'system_prompt', taint, throwawayCanaries);
  return prepared.ok && prepared.value === summary;
};

// Summary text is disposable display data, not tool authority. During an active
// forget, neutralize malformed Unicode-escaped displays rather than guess at a
// partial JSON string. Valid JSON uses the existing decoded-value redactor.
const summaryRedactor = (texts: readonly string[], marker: string) => {
  const active = texts.some(text => text.trim());
  const redact = literalJsonTextRedactor(texts, marker, 'data');
  return (summary: string): string => {
    if (!active) return summary;
    try {
      if (/\\u/i.test(summary)) JSON.parse(summary);
      return redact(summary);
    } catch { return marker; }
  };
};

const ledgerSourcesFromRows = (topic: string, rows: Iterable<[string, ToolOutputEntry]>): { sources: { ref: string; text: string }[]; incomplete: boolean } => {
  const sources: { ref: string; text: string }[] = [];
  let incomplete = false;
  for (const [key, row] of rows) {
    let index = 0;
    const before = sources.length;
    const add = (text: string) => { if (asciiLiteralIncludes(text, topic)) sources.push({ ref: `ledger:${key}:${index++}`, text }); };
    add(row.summary);
    const decoded = (value: unknown): void => {
      if (typeof value === 'string') add(value);
      else if (Array.isArray(value)) value.forEach(decoded);
      else if (value && typeof value === 'object') for (const [name, child] of Object.entries(value)) {
        if (asciiLiteralIncludes(name, topic)) incomplete = true;
        add(name); decoded(child);
      }
    };
    try { decoded(JSON.parse(row.summary)); } catch { /* A capped or otherwise unparseable summary is held only when its decoded text hides the topic (the safety line below); an unrelated \\u escape no longer holds every forget. */ if (hidesTopic(row.summary, topic)) incomplete = true; }
    // Shared safety line. A row whose decoded text carries the topic goes to the selector and its redaction re-serialises the row; any other row with a hiding escape (or the topic in a NUL-bearing string) cannot be proven clean from a parse, so it is held.
    if (sources.length === before && (hidesTopic(row.summary, topic) || (row.summary.includes('\0') && carriesTopic(row.summary, topic)))) incomplete = true;
  }
  return { sources, incomplete };
};

// Each kept row with what a later turn may read of it; a row that names an approval the desk can't answer for is left out.
const shownRows = async (storage: KeyValueStorage, options: Readonly<{ proposalState?: ProposalState }>, texts: readonly string[]) => {
  const redact = summaryRedactor(texts, '[forgotten]');
  const rows = await storage.list<ToolOutputEntry>({ prefix: 'toolout:' });
  const entries = [...rows.entries()]
    .filter(([key]) => key !== 'toolout-count')
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-MAX_KEPT);
  // Same guard on read: legacy entries persisted before the write guard existed are evicted
  // from storage (self-heal - this is the eviction the dead-turn ring could not perform) and
  // excluded from the staged fragments, so the next turn composes clean and the ring resumes.
  const poisonedKeys: string[] = [];
  const clean = entries.filter(([key, entry]) => {
    if (admitsForPrompt(entry.summary, 'external')) return true;
    poisonedKeys.push(key);
    return false;
  });
  if (poisonedKeys.length > 0) await storage.delete(poisonedKeys);
  // An output that names an approval shows the desk's current state, never its snapshot; without one it is withheld.
  const current = await Promise.all(clean.map(async ([, entry]) => {
    const id = entry.proposal_ref === undefined ? linkOf(entry.tool, entry.summary) : entry.proposal_ref;
    if (id === undefined || id === null) return { shown: redact(entry.summary), desk: false };
    const state = id && options.proposalState ? await options.proposalState(id).catch(() => null) : null;
    return state ? { shown: `proposed approval ${id} (${state.kind}). Its current state on the approval desk is ${state.state}; this replaces what the tool reported when it proposed.`, desk: true } : null;
  }));
  return clean.flatMap(([key, entry], index) => {
    const row = current[index];
    return !row ? [] : [{ entry, seq: key.slice('toolout:'.length), desk: row.desk, text: `${entry.tool} ${entry.ok ? 'succeeded' : 'failed'}: ${row.shown}` }];
  });
};

export const toolOutputLedger = (storage: KeyValueStorage, options: Readonly<{ proposalState?: ProposalState }> = {}) => ({
  forgetSourceBatchCurrent(topic: string) {
    const all = this.forgetSourcesCurrent(topic);
    if (!all) return null;
    const batch = forgetSourceBatch(topic, all.sources);
    return { ...batch, incomplete: batch.incomplete || all.incomplete };
  },
  async forgetSourceBatch(topic: string) {
    const all = await this.forgetSources(topic);
    const batch = forgetSourceBatch(topic, all.sources);
    return { ...batch, incomplete: batch.incomplete || all.incomplete };
  },
  forgetSourcesCurrent(topic: string) { return storage.kv?.list ? ledgerSourcesFromRows(topic, storage.kv.list<ToolOutputEntry>({ prefix: 'toolout:' })) : null; },
  async forgetSources(topic: string) { return ledgerSourcesFromRows(topic, await storage.list<ToolOutputEntry>({ prefix: 'toolout:' })); },
  async record(entry: Omit<ToolOutputEntry, 'at'> & { at: number }, scope?: RunEffectScope): Promise<void> {
    const summary = entry.summary.length > MAX_SUMMARY_CHARS ? `${entry.summary.slice(0, MAX_SUMMARY_CHARS)}...` : entry.summary;
    // Admission guard at write time: a poisoned summary is dropped, never persisted.
    if (!admitsForPrompt(summary, 'external')) return;
    const link = linkOf(entry.tool, entry.summary);
    const row: ToolOutputEntry = { ...entry, summary, ...(link === undefined ? {} : { proposal_ref: link }) };
    const count = (await storage.get<number>('toolout-count')) ?? 0;
    if (scope) {
      if (!storage.kv) throw new Error('fenced synchronous ledger unavailable');
      scope.commit(() => { storage.kv!.put(entryKey(count), row); storage.kv!.put('toolout-count', count + 1); if (count + 1 > MAX_KEPT) storage.kv!.delete(entryKey(count - MAX_KEPT)); });
      return;
    }
    await storage.put({ [entryKey(count)]: row, 'toolout-count': count + 1 });
    // Ring: drop the oldest once we exceed the cap.
    if (count + 1 > MAX_KEPT) await storage.delete([entryKey(count - MAX_KEPT)]);
  },
  // Verification covers every retained row, not just the six staged fragments.
  async remaining(texts: readonly string[]): Promise<number> {
    const redact = summaryRedactor(texts, '[forgotten]');
    const rows = await storage.list<ToolOutputEntry>({ prefix: 'toolout:' });
    return [...rows.values()].filter(entry => redact(entry.summary) !== entry.summary).length;
  },
  async recent(texts: readonly string[] = []): Promise<readonly ContextFragment[]> {
    return (await shownRows(storage, options, texts)).map(({ entry, seq, text }) => ({
      text,
      source: {
        // The row sequence keeps two same-tool calls in one millisecond distinct: the timestamp alone repeats.
        source_key: `tool_output:${entry.tool}:${entry.at}:${seq}`,
        source_kind: 'tool_result' as const,
        scope: 'invocation' as const,
        source_taint: 'external' as const,
        produced_at: entry.at,
      },
    }));
  },
  // What the owner's own earlier turns' tools returned. Provider text never carries across turns: an external result shows
  // only when it is the desk's state for an approval it proposed.
  async ownerTurnResults(texts: readonly string[] = []): Promise<readonly string[]> {
    return (await shownRows(storage, options, texts)).filter(({ entry, desk }) => entry.origin === 'owner' && (desk || entry.taint === null)).map(({ text }) => text);
  },
});

// Forget coverage: a claim's exact text can be quoted inside a kept tool-output summary, so
// purge redacts the ring in place (same literal match as the conversation store; paraphrases
// remain the documented limit). Rows keep their keys, order and taint stamps.
export const redactToolOutputLedger = async (storage: KeyValueStorage, texts: readonly string[], marker: string, scope?: RunEffectScope): Promise<number> => {
  const rows = await storage.list<ToolOutputEntry>({ prefix: 'toolout:' });
  let touched = 0;
  const writes: Record<string, unknown> = {};
  // Case-insensitive literal match, same rule as the conversation store: a casing variant of a
  // forgotten text surviving into next-turn context is the leak returning.
  // Summaries are capped display data; tool/ok/taint authority stays on the ledger entry.
  const redact = summaryRedactor(texts, marker);
  for (const [key, entry] of rows) {
    if (key === 'toolout-count') continue;
    const summary = redact(entry.summary);
    if (summary !== entry.summary) {
      writes[key] = { ...entry, summary };
      touched += 1;
    }
  }
  if (Object.keys(writes).length) {
    if (scope) { if (!storage.kv) throw new Error('fenced redaction ledger unavailable'); scope.commit(() => { for (const [key, value] of Object.entries(writes)) storage.kv!.put(key, value); }); }
    else await storage.put(writes);
  }
  return touched;
};
