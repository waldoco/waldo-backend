import { describe, expect, it } from 'vitest';
import { acceptTrustedInvocation } from '@waldo/contracts';
import { toolOutputLedger } from '../src/conversation/tool-output-ledger';
import { JoinedConversationPath } from '../src/conversation/joined-path';
import {
  localTrustedBriefScheduleInput,
  localTrustedBriefTurnSnapshot,
  resolveRunLoopAdapters,
} from '../src/run-loop/adapters';

const CANARIES = ['0123456789abcdef', 'fedcba9876543210', '0011223344556677'];

const fakeStorage = () => {
  const data = new Map<string, unknown>();
  return {
    get: async <T,>(k: string) => data.get(k) as T | undefined,
    list: async <T,>({ prefix }: { prefix: string }) => new Map([...data].filter(([k]) => k.startsWith(prefix)) as [string, T][]),
    put: async (rows: Record<string, unknown>) => { for (const [k, v] of Object.entries(rows)) data.set(k, v); },
    delete: async (keys: string[]) => { for (const k of keys) data.delete(k); },
  };
};

// Mirrors the production telegram turn wiring (channels/telegram-turn.ts): one fixture
// invocation, the local trusted-brief composer fed by the tool-output ledger, one joined
// conversation path. The model seam is a stub; the regression targets context composition.
const harness = () => {
  const fixture = localTrustedBriefScheduleInput();
  const accepted = acceptTrustedInvocation(fixture.admission);
  if (!accepted.ok) throw new Error('fixture admission failed');
  const invocation = accepted.value;
  const ownerId = invocation.verified_authority.principal_ref;
  const ledger = toolOutputLedger(fakeStorage());
  const adapters = resolveRunLoopAdapters({ WALDO_ENV: 'local' }, { toolOutputs: () => ledger.recent() });
  const path = new JoinedConversationPath(adapters.contextComposer!, { complete: async () => 'noted.' });
  let parentId: string | null = null;
  const turn = async (id: string, said: string, snapshot: Readonly<{ snapshot_ref: string; snapshot_at: number }>) => {
    const publication = await path.submit({
      authenticatedOwnerId: ownerId,
      invocation,
      context: { ...snapshot, canary_tokens: CANARIES, replay_context_ref: null },
      userEntry: {
        id, ownerId, chatId: 'telegram-1', parentId, threadAnchorId: null, surface: 'telegram',
        modelPayload: said, appPayload: said, modelProjection: { mode: 'include' },
      },
      assistantEntryId: `${id}-reply`,
    });
    parentId = publication.leafId;
    return publication;
  };
  return { fixture, ledger, turn };
};

describe('telegram turn snapshot attestation', () => {
  it('reproduces the poisoning: a frozen fixture snapshot rejects the turn after a tool output', async () => {
    const { fixture, ledger, turn } = harness();
    const frozen = { snapshot_ref: fixture.snapshot_ref, snapshot_at: fixture.snapshot_at };
    await turn('t1', 'trace check', frozen);
    // What the turn harness records after a successful web_search (real wall-clock time).
    await ledger.record({ tool: 'web_search', ok: true, at: Date.now(), taint: 'external', summary: 'Cloudflare docs excerpt' });
    await expect(turn('t2', 'remind me tomorrow', frozen)).rejects.toThrow('provenance_invalid');
  });

  it('composes two sequential turns with a persisted tool output when the snapshot is live per turn', async () => {
    const { ledger, turn } = harness();
    const first = await turn('t1', 'trace check', localTrustedBriefTurnSnapshot());
    expect(first.text).toBe('noted.');
    await ledger.record({ tool: 'web_search', ok: true, at: Date.now(), taint: 'external', summary: 'Cloudflare docs excerpt' });
    const second = await turn('t2', 'remind me tomorrow', localTrustedBriefTurnSnapshot());
    expect(second.text).toBe('noted.');
    const third = await turn('t3', 'and another', localTrustedBriefTurnSnapshot());
    expect(third.text).toBe('noted.');
  });

  it('still rejects a future-dated snapshot (the bound is not weakened upward)', async () => {
    const { fixture, turn } = harness();
    const future = { snapshot_ref: fixture.snapshot_ref, snapshot_at: Date.now() + 3_600_000 };
    await expect(turn('t1', 'trace check', future)).rejects.toThrow('input_integrity');
  });
});
