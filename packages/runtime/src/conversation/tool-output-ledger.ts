// Recent tool outputs as composable context (BUILD_ORDER 12). The tool loop's outputs
// used to live only inside one turn; this ledger keeps the last few so the context
// composer can stage them as tool_result sources with provenance and taint.
import type { ContextFragment } from '../context-composer/types';
import type { SourceTaint } from '@waldo/contracts';
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

// Tool-output summaries are staged into every later turn's prompt canvas as tool_result
// fragments. A summary the scribe denies at that boundary (canary-shaped 16-hex token, fence
// closer, injected instruction, structured secret) must never persist: once inside the ring it
// fails every turn BEFORE any tool call can record, so the ring never rotates and the outage is
// self-sustaining - the 2026-09-27 staging reply-outage root cause (trace chain
// fbdd97e1 -> 8e717c7e -> :material:tool_result). Exact session canaries are per-runtime and
// unknown at ledger time; the shape/fence/instruction guards are turn-independent and catch the class.
const admitsForPrompt = (summary: string, taint: SourceTaint): boolean => {
  // The exact-canary check is turn-scoped and meaningless here (the real tokens do not exist
  // yet), but the contract schema requires exactly 3 distinct 16-hex tokens. Random throwaway
  // tokens satisfy the schema with no false-positive risk (48 hex chars of entropy per call)
  // while the shape/fence/secret scans - the turn-independent guards this admission check
  // exists for - run unchanged. The payload must survive unrewritten: a fragment the scribe
  // would transform on its way to the canvas is staged differently than what was recorded.
  const throwawayCanaries = Array.from({ length: 3 }, () => crypto.randomUUID().replaceAll('-', '').slice(0, 16));
  const prepared = prepareWithScribe(summary, summaryAdmissionSchema, 'system_prompt', taint, throwawayCanaries);
  return prepared.ok && prepared.value === summary;
};

export const toolOutputLedger = (storage: KeyValueStorage) => ({
  async record(entry: Omit<ToolOutputEntry, 'at'> & { at: number }): Promise<void> {
    const summary = entry.summary.length > MAX_SUMMARY_CHARS ? `${entry.summary.slice(0, MAX_SUMMARY_CHARS)}...` : entry.summary;
    // Admission guard at write time: a poisoned summary is dropped, never persisted.
    if (!admitsForPrompt(summary, entry.taint)) return;
    const count = (await storage.get<number>('toolout-count')) ?? 0;
    await storage.put({ [entryKey(count)]: { ...entry, summary }, 'toolout-count': count + 1 });
    // Ring: drop the oldest once we exceed the cap.
    if (count + 1 > MAX_KEPT) await storage.delete([entryKey(count - MAX_KEPT)]);
  },
  async recent(): Promise<readonly ContextFragment[]> {
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
      text: `${entry.tool} ${entry.ok ? 'succeeded' : 'failed'}: ${entry.summary}`,
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
export const redactToolOutputLedger = async (storage: KeyValueStorage, texts: readonly string[], marker: string): Promise<number> => {
  const rows = await storage.list<ToolOutputEntry>({ prefix: 'toolout:' });
  let touched = 0;
  const writes: Record<string, unknown> = {};
  // Case-insensitive literal match, same rule as the conversation store: a casing variant of a
  // forgotten text surviving into next-turn context is the leak returning.
  const patterns = [...new Set(texts.map((text) => text.trim()).filter(Boolean))]
    .map((text) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'));
  for (const [key, entry] of rows) {
    if (key === 'toolout-count') continue;
    let summary = entry.summary;
    for (const pattern of patterns) summary = summary.replace(pattern, marker);
    // Fresh post-scan on the rewritten text: if any variant somehow survives, the whole summary
    // becomes the marker - context loss beats leaking a forgotten text.
    if (patterns.some((pattern) => new RegExp(pattern.source, 'i').test(summary))) summary = marker;
    if (summary !== entry.summary) {
      writes[key] = { ...entry, summary };
      touched += 1;
    }
  }
  if (Object.keys(writes).length) await storage.put(writes);
  return touched;
};
