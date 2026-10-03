import type { RunEffectScope } from '../channels/run-effect-scope';
import { asciiLiteralIncludes } from '../memory/selective-forget';
// Recent tool outputs as composable context (BUILD_ORDER 12). The tool loop's outputs
// used to live only inside one turn; this ledger keeps the last few so the context
// composer can stage them as tool_result sources with provenance and taint.
import type { ContextFragment } from '../context-composer/types';
import { literalJsonTextRedactor, type SourceTaint } from '@waldo/contracts';
import { prepareWithScribe, type StrictSchema } from '../scribe/prepare';

export type ToolOutputEntry = Readonly<{
  tool: string;
  ok: boolean;
  at: number;
  taint: SourceTaint;
  summary: string;
}>;

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
    try { decoded(JSON.parse(row.summary)); } catch { if (/\\u/i.test(row.summary)) incomplete = true; }
  }
  return { sources, incomplete };
};

export const toolOutputLedger = (storage: KeyValueStorage) => ({
  forgetSourcesCurrent(topic: string) { return storage.kv?.list ? ledgerSourcesFromRows(topic, storage.kv.list<ToolOutputEntry>({ prefix: 'toolout:' })) : null; },
  async forgetSources(topic: string) { return ledgerSourcesFromRows(topic, await storage.list<ToolOutputEntry>({ prefix: 'toolout:' })); },
  async record(entry: Omit<ToolOutputEntry, 'at'> & { at: number }, scope?: RunEffectScope): Promise<void> {
    const summary = entry.summary.length > MAX_SUMMARY_CHARS ? `${entry.summary.slice(0, MAX_SUMMARY_CHARS)}...` : entry.summary;
    // Admission guard at write time: a poisoned summary is dropped, never persisted.
    if (!admitsForPrompt(summary, entry.taint)) return;
    const count = (await storage.get<number>('toolout-count')) ?? 0;
    if (scope) {
      if (!storage.kv) throw new Error('fenced synchronous ledger unavailable');
      scope.commit(() => { storage.kv!.put(entryKey(count), { ...entry, summary }); storage.kv!.put('toolout-count', count + 1); if (count + 1 > MAX_KEPT) storage.kv!.delete(entryKey(count - MAX_KEPT)); });
      return;
    }
    await storage.put({ [entryKey(count)]: { ...entry, summary }, 'toolout-count': count + 1 });
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
      if (admitsForPrompt(entry.summary, entry.taint)) return true;
      poisonedKeys.push(key);
      return false;
    });
    if (poisonedKeys.length > 0) await storage.delete(poisonedKeys);
    return clean.map(([, entry]) => entry).map((entry) => ({
      text: `${entry.tool} ${entry.ok ? 'succeeded' : 'failed'}: ${redact(entry.summary)}`,
      source: {
        source_key: `tool_output:${entry.tool}:${entry.at}`,
        source_kind: 'tool_result' as const,
        scope: 'invocation' as const,
        source_taint: entry.taint,
        produced_at: entry.at,
      },
    }));
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
