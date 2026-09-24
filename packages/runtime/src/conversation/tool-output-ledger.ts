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
