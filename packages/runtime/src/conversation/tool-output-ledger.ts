// Recent tool outputs as composable context (BUILD_ORDER 12). The tool loop's outputs
// used to live only inside one turn; this ledger keeps the last few so the context
// composer can stage them as tool_result sources with provenance and taint.
import type { ContextFragment } from '../context-composer/types';
import type { SourceTaint } from '@waldo/contracts';

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

export const toolOutputLedger = (storage: KeyValueStorage) => ({
  async record(entry: Omit<ToolOutputEntry, 'at'> & { at: number }): Promise<void> {
    const count = (await storage.get<number>('toolout-count')) ?? 0;
    const summary = entry.summary.length > MAX_SUMMARY_CHARS ? `${entry.summary.slice(0, MAX_SUMMARY_CHARS)}...` : entry.summary;
    await storage.put({ [entryKey(count)]: { ...entry, summary }, 'toolout-count': count + 1 });
    // Ring: drop the oldest once we exceed the cap.
    if (count + 1 > MAX_KEPT) await storage.delete([entryKey(count - MAX_KEPT)]);
  },
  async recent(): Promise<readonly ContextFragment[]> {
    const rows = await storage.list<ToolOutputEntry>({ prefix: 'toolout:' });
    const entries = [...rows.entries()]
      .filter(([key]) => key !== 'toolout-count')
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-MAX_KEPT)
      .map(([, entry]) => entry);
    return entries.map((entry) => ({
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
