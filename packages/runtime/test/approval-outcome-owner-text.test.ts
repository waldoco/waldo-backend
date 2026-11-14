import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { buildSessionState } from '@waldo/contracts';
import { approvalDesk, type ApprovalDecision, type McpCallProposal } from '../src/channels/approvals';
import { ownerEffectLedger } from '../src/channels/owner-effect-ledger';
import { McpRefusal, McpToolFailed } from '../src/connectors/mcp-connections';
import { sanitise } from '../src/scribe/sanitiser';
import { sha256Hex } from '../src/connectors/google';
import { stableJson } from '../src/context-composer/canonical';
import { taintedActionReplay } from '../src/tools/live/propose-action';

// What the owner reads after approving a card is what was done, never a server's answer, its error text or the text a
// refusal wrote for the model, which can carry ids, readings or internal tool names. Synthetic values.
const CARD: McpCallProposal = { server: 'tracker', tool: 'create_issue', args: { title: 'Follow up' }, connection: '00000000-0000-4000-8000-000000000001', tool_digest: 'a'.repeat(64) };
const INTERNAL = 'tracker_internal_validate';
const NUMBER = '48213';

type Rig = Readonly<{ decision: ApprovalDecision; status: string; summary: string; sent: readonly string[]; ran: number }>;
const approveMcp = (name: string, mcpCall: () => Promise<string | { provider_id: string; result: unknown }>, withEffects: boolean): Promise<Rig> =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`owner-text-${name}-${withEffects}-${crypto.randomUUID()}`)), async (_instance, state) => {
    let n = 0, ran = 0;
    const sent: string[] = [];
    const desk = approvalDesk(state.storage.sql, {
      call: async (_method, body) => { sent.push(String((body as { text?: unknown }).text ?? '')); return { message_id: sent.length }; }, owner: 42, google: async () => null,
      newId: () => `${name}-${++n}`, now: () => 1_000_000, timezone: 'UTC', log: () => undefined,
      mcpCall: async () => { ran++; return mcpCall(); },
      ...(withEffects ? { effects: ownerEffectLedger(state.storage, () => 1_000_000) } : {}),
    });
    const id = await desk.proposeMcpCall(CARD);
    const decision = await desk.decide(id, 'a', 't');
    const { status, summary } = state.storage.sql.exec<{ status: string; summary: string }>('SELECT status, summary FROM ledger WHERE id = ?', id).one();
    return { decision, status, summary, sent, ran };
  });
const ownerText = (rig: Rig) => [rig.decision.toast, rig.decision.message, ...rig.sent.slice(1)].join('\n');

describe('an approved MCP card tells the owner what was done, never what the server said', () => {
  for (const withEffects of [false, true]) {
    it(`a call that ran shows the card's own words, not the server's answer (${withEffects ? 'with' : 'without'} the effect ledger)`, async () => {
      const answer = `Result (external content, bounded): {"issue":${NUMBER},"via":"${INTERNAL}"}`;
      const rig = await approveMcp('done', async () => withEffects ? { provider_id: 'approval:x:apply', result: answer } : answer, withEffects);
      expect(rig.ran).toBe(1);
      expect(rig.status).toBe('done');
      expect(rig.decision.toast).toBe('Done');
      expect(rig.decision.message).toContain(rig.summary);
      for (const leaked of [NUMBER, INTERNAL, 'external content', '{']) expect(ownerText(rig)).not.toContain(leaked);
    });

    it(`a tool that reported an error gives a fixed line, never the server's error text (${withEffects ? 'with' : 'without'} the effect ledger)`, async () => {
      const rig = await approveMcp('tool-failed', async () => { throw new McpToolFailed(`tracker's create_issue ran and reported an error. tracker said (its own words, not Waldo's): "row ${NUMBER} rejected by ${INTERNAL}"`); }, withEffects);
      expect(rig.ran).toBe(1);
      expect(rig.status).toBe('failed');
      expect(rig.decision.toast).toBe('That failed');
      expect(rig.decision.message).toContain(rig.summary);
      for (const leaked of [NUMBER, INTERNAL, 'its own words']) expect(ownerText(rig)).not.toContain(leaked);
    });

    it(`a refusal that proves nothing ran gives a fixed line, never the refusal written for the model (${withEffects ? 'with' : 'without'} the effect ledger)`, async () => {
      const rig = await approveMcp('not-run', async () => {
        throw new McpRefusal('auth_failed', 'The sign-in for tracker is no longer valid. Ask the owner to reconnect tracker in Connections on their Waldo console (send_console_link sends it), or use connect_app for an app it lists.', true);
      }, withEffects);
      expect(rig.status).toBe('failed');
      expect(rig.decision.toast).toBe('Nothing ran');
      expect(rig.decision.message).toContain(rig.summary);
      for (const leaked of ['send_console_link', 'connect_app', 'the owner']) expect(ownerText(rig)).not.toContain(leaked);
    });

    it(`a server no longer connected is told apart from one that may take it on a retry (${withEffects ? 'with' : 'without'} the effect ledger)`, async () => {
      const gone = await approveMcp('gone', async () => { throw new McpRefusal('not_found', 'tracker is no longer connected.', true); }, withEffects);
      const busy = await approveMcp('busy', async () => { throw new McpRefusal('transient', 'tracker did not answer in time.', true); }, withEffects);
      expect([gone.decision.toast, busy.decision.toast]).toEqual(['Nothing ran', 'Nothing ran']);
      expect(gone.decision.message.replace(gone.summary, '')).not.toBe(busy.decision.message.replace(busy.summary, ''));
    });
  }
});

describe('an approved carded action whose tool no longer exists', () => {
  it('says nothing was done without naming the internal tool', async () => {
    await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`owner-text-gone-${crypto.randomUUID()}`)), async (_instance, state) => {
      const canaries = ['0123456789abcdef', 'fedcba9876543210', '0011223344556677'];
      const replay = taintedActionReplay({ handlers: () => [], context: () => ({
        authenticatedUserId: 'owner-1', trigger: 'user_message', canaryTokens: canaries, sourceTaint: null, toolArgSourceTaint: 'external', sanitise, hasApproval: () => true,
        session: buildSessionState({ trigger: 'user_message', canary_tokens: canaries, started_at: Date.now() }),
      }) });
      const desk = approvalDesk(state.storage.sql, { owner: 42, call: async () => ({ message_id: 1 }), google: async () => null, newId: () => 'gone', now: () => 1_000_000, timezone: 'UTC', log: () => undefined, replayTaintedAction: replay });
      const args = { note: 'Follow up' };
      const id = await desk.proposeTaintedAction({ tool: INTERNAL, args, args_digest: await sha256Hex(stableJson(args)), reasoning: 'A forwarded mail asked for it.', source: 'external' });
      const out = await desk.decide(id, 'a', 't');
      expect(out.toast).toBe('Not done');
      expect(state.storage.sql.exec<{ status: string }>('SELECT status FROM ledger WHERE id = ?', id).one().status).toBe('rejected');
      expect(out.message).not.toContain(INTERNAL);
    });
  });
});
