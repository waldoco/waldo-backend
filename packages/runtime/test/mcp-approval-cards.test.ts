import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { approvalDesk, type McpCallProposal } from '../src/channels/approvals';
import { ownerEffectLedger } from '../src/channels/owner-effect-ledger';
import { approvalControlReceipt } from '../src/channels/dashboard-control-actions';
import { McpRefusal, McpToolFailed } from '../src/connectors/mcp-connections';

const OWNER_CARD: McpCallProposal = {
  server: 'tracker', tool: 'create_issue', args: { title: 'Follow up' }, connection: '00000000-0000-4000-8000-000000000001', tool_digest: 'a'.repeat(64),
  answers: { handle: 'q_abc', responses: { project: { action: 'accept', content: { project: 'Web' } } } }, questions: [{ id: 'project', message: 'Which project?' }],
};

// One desk over a fresh owner object; ran records every call the approved card made.
const rig = (name: string, mcpCall: (proposal: McpCallProposal) => Promise<string | { provider_id: string; result: unknown }>, withEffects = false) => async (run: (deps: Readonly<{ desk: ReturnType<typeof approvalDesk>; sql: SqlStorage; sent: string[]; ran: McpCallProposal[] }>) => Promise<void>) => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`mcp-cards-${name}`)), async (_instance, state) => {
    let n = 0;
    const sent: string[] = [], ran: McpCallProposal[] = [];
    const desk = approvalDesk(state.storage.sql, {
      call: async (_method, body) => { sent.push(String((body as { text?: unknown }).text ?? '')); return {}; }, owner: 42, google: async () => null, newId: () => `${name}-${++n}`, now: () => 1_000_000, timezone: 'UTC', log: () => undefined,
      mcpCall: async (proposal) => { ran.push(proposal); return mcpCall(proposal); },
      ...(withEffects ? { effects: ownerEffectLedger(state.storage, () => 1_000_000) } : {}),
    });
    await run({ desk, sql: state.storage.sql, sent, ran });
  });
};

describe('MCP approval cards for owner-connected servers', () => {
  it('show the server\'s questions next to the owner\'s answers, run the frozen call once, and refuse a second approve', () => rig('once', async () => ({ provider_id: 'approval:x:apply', result: 'Result: created' }))(async ({ desk, sent, ran }) => {
    const id = await desk.proposeMcpCall(OWNER_CARD);
    expect(sent[0]).toContain('The server asked (its words):\n- Which project?');
    expect(sent[0]).toContain('"project": "Web"');
    expect((await desk.decide(id, 'a', 't')).toast).toBe('Done');
    expect(ran).toEqual([expect.objectContaining({ connection: OWNER_CARD.connection, tool_digest: OWNER_CARD.tool_digest, answers: OWNER_CARD.answers })]);
    expect((await desk.decide(id, 'a', 't')).toast).toBe('Already handled.');
    expect(ran).toHaveLength(1);
  }));

  it('refuses a stored card whose call no longer matches its digest, and runs nothing', () => rig('tampered', async () => 'ran')(async ({ desk, sql, ran }) => {
    const id = await desk.proposeMcpCall(OWNER_CARD);
    sql.exec('UPDATE ledger SET payload_json = ? WHERE id = ?', JSON.stringify({ ...OWNER_CARD, args: { title: 'Something else' } }), id);
    const out = await desk.decide(id, 'a', 't');
    expect(out).toMatchObject({ toast: 'Call changed' });
    expect(approvalControlReceipt(out)).toEqual({ state: 'rejected', message: 'The stored call no longer matches what was approved, so nothing ran.' });
    expect(ran).toEqual([]);
    // A card for an owner-connected server never runs without a digest at all.
    const bare = await desk.proposeMcpCall(OWNER_CARD);
    sql.exec('UPDATE ledger SET proposal_digest = NULL WHERE id = ?', bare);
    expect((await desk.decide(bare, 'a', 't')).toast).toBe('Call changed');
    expect(ran).toEqual([]);
  }));

  for (const withEffects of [false, true]) {
    it(`reports "That failed" when the tool ran and returned an error (${withEffects ? 'with' : 'without'} the effect ledger)`, async () => {
      await rig(`tool-failed-${withEffects}`, async () => { throw new McpToolFailed("tracker's create_issue ran and reported an error: Title is required."); }, withEffects)(async ({ desk, sql, ran }) => {
        const id = await desk.proposeMcpCall(OWNER_CARD);
        expect(await desk.decide(id, 'a', 't')).toEqual({ toast: 'That failed', message: "Run create_issue on the tracker MCP server ran and failed: tracker's create_issue ran and reported an error: Title is required." });
        expect(sql.exec<{ status: string }>('SELECT status FROM ledger WHERE id = ?', id).one().status).toBe('failed');
        expect((await desk.decide(id, 'a', 't')).toast).toBe('Already handled.');
        expect(ran).toHaveLength(1);
      });
    });

    it(`reports "nothing ran" only when the refusal proves it, and an unknown outcome otherwise (${withEffects ? 'with' : 'without'} the effect ledger)`, async () => {
      await rig(`not-run-${withEffects}`, async () => { throw new McpRefusal('auth_failed', 'The sign-in for tracker is no longer valid.', true); }, withEffects)(async ({ desk, sql }) => {
        const id = await desk.proposeMcpCall(OWNER_CARD);
        const out = await desk.decide(id, 'a', 't');
        expect(out).toEqual({ toast: 'Nothing ran', message: 'Nothing ran: The sign-in for tracker is no longer valid.' });
        expect(approvalControlReceipt(out).state).toBe('rejected');
        expect(sql.exec<{ status: string }>('SELECT status FROM ledger WHERE id = ?', id).one().status).toBe('failed');
      });
      await rig(`unknown-${withEffects}`, async () => { throw new McpRefusal('transient', 'The outcome of this tracker call is unknown; nothing was run again.'); }, withEffects)(async ({ desk, sql }) => {
        const id = await desk.proposeMcpCall(OWNER_CARD);
        expect((await desk.decide(id, 'a', 't')).toast).toBe('Outcome unknown');
        expect(sql.exec<{ status: string }>('SELECT status FROM ledger WHERE id = ?', id).one().status).toBe('uncertain');
      });
    });
  }
});
