import { describe, expect, it } from 'vitest';
import { intersectToolAcl, type ToolAclInput } from './acl-intersection';
import { TOOL_PERMISSIONS, type ToolName } from './permissions';

const inTrigger = TOOL_PERMISSIONS.user_message;
const pick = (n: number): ToolName[] => inTrigger.slice(0, n) as ToolName[];
const base = (extra: Partial<ToolAclInput> = {}): ToolAclInput => ({
  trigger: 'user_message',
  handlers: pick(4),
  grants: { status: 'available', tools: pick(4) },
  connectors: { status: 'available', tools: pick(4) },
  connector_backed: [],
  ...extra,
});

describe('tool ACL intersection', () => {
  it('returns handlers that are in the trigger permissions and in the grants', () => {
    expect(intersectToolAcl(base())).toMatchObject({ status: 'admitted', tools: pick(4) });
  });

  it('unavailable grants give the empty set with a closed reason, never a default-allow', () => {
    expect(intersectToolAcl(base({ grants: { status: 'unavailable' } }))).toEqual({ status: 'denied', reason: 'grants_unavailable', tools: [] });
  });

  it('unavailable connectors remove every connector-backed tool and keep the rest', () => {
    const backed = pick(2);
    const result = intersectToolAcl(base({ connectors: { status: 'unavailable' }, connector_backed: backed }));
    expect(result).toMatchObject({ status: 'admitted', tools: pick(4).filter((t) => !backed.includes(t)), degraded: 'connectors_unavailable' });
  });

  it('a tool missing from grants, handlers or the trigger is removed; the result is never wider than any input', () => {
    const narrowGrants = intersectToolAcl(base({ grants: { status: 'available', tools: pick(2) } }));
    expect(narrowGrants).toMatchObject({ status: 'admitted', tools: pick(2) });
    const narrowHandlers = intersectToolAcl(base({ handlers: pick(1) }));
    expect(narrowHandlers).toMatchObject({ status: 'admitted', tools: pick(1) });
    const outsideTrigger = (Object.keys(TOOL_PERMISSIONS) as Array<keyof typeof TOOL_PERMISSIONS>)
      .filter((t) => t !== 'user_message')
      .map((t) => ({ t, tool: TOOL_PERMISSIONS.user_message.find((n) => !TOOL_PERMISSIONS[t].includes(n)) }))
      .find((x) => x.tool !== undefined);
    expect(outsideTrigger).toBeDefined();
    const { t, tool } = outsideTrigger!;
    const r = intersectToolAcl(base({ trigger: t, handlers: [tool!], grants: { status: 'available', tools: [tool!] } }));
    expect(r.tools).toEqual([]);
  });

  it('an empty grant set admits nothing and is not treated as unavailable', () => {
    expect(intersectToolAcl(base({ grants: { status: 'available', tools: [] } }))).toMatchObject({ status: 'admitted', tools: [] });
  });

  it('output order and duplicates are deterministic', () => {
    const dup = [...pick(3), ...pick(3)];
    expect(intersectToolAcl(base({ handlers: dup, grants: { status: 'available', tools: [...dup].reverse() } })).tools).toEqual(pick(3));
  });
});

// Reachable-tool cases use real registered tool names. connector_backed here mirrors the per-handler
// Google feature each live handler hardcodes today (tools/live/google.ts withGoogle(..., feature)); there is
// no central table yet, which the design note flags.
describe('tool ACL intersection: installed and granted operations stay reachable', () => {
  const installed: ToolName[] = ['query_calendar', 'get_communication', 'get_tasks', 'read_artifact', 'export_artifact', 'read_mcp_tool', 'web_search'];
  const backed: ToolName[] = ['query_calendar', 'get_communication', 'get_tasks'];
  const real = (extra: Partial<ToolAclInput> = {}): ToolAclInput => ({
    trigger: 'user_message',
    handlers: installed,
    grants: { status: 'available', tools: installed },
    connectors: { status: 'available', tools: backed },
    connector_backed: backed,
    ...extra,
  });

  it('every installed, granted, connected operation the trigger allows is admitted with nothing removed', () => {
    const r = intersectToolAcl(real());
    expect(r).toEqual({ status: 'admitted', tools: installed, removed: [], findings: [] });
  });

  it('every removal carries its own closed reason, so nothing is suppressed silently', () => {
    const r = intersectToolAcl(real({ grants: { status: 'available', tools: installed.filter((t) => t !== 'web_search') }, connectors: { status: 'available', tools: ['query_calendar'] } }));
    expect(r.status).toBe('admitted');
    if (r.status !== 'admitted') return;
    expect(r.tools).toEqual(['query_calendar', 'read_artifact', 'export_artifact', 'read_mcp_tool']);
    expect(r.removed).toEqual([
      { tool: 'get_communication', reason: 'connector_not_listed' },
      { tool: 'get_tasks', reason: 'connector_not_listed' },
      { tool: 'web_search', reason: 'not_granted' },
    ]);
  });

  it('a tool outside the trigger is removed with reason not_in_trigger, not reported as a defect', () => {
    const other = (Object.keys(TOOL_PERMISSIONS) as Array<keyof typeof TOOL_PERMISSIONS>).find((t) => t !== 'user_message' && installed.some((n) => !TOOL_PERMISSIONS[t].includes(n)));
    expect(other).toBeDefined();
    const r = intersectToolAcl(real({ trigger: other! }));
    if (r.status !== 'admitted') throw new Error('expected admitted');
    expect(r.removed.every((x) => x.reason === 'not_in_trigger' || x.reason === 'not_granted' || x.reason === 'connector_not_listed')).toBe(true);
    expect(r.removed.some((x) => x.reason === 'not_in_trigger')).toBe(true);
    expect(r.findings).toEqual([]);
  });

  it('unavailable and stale grants are distinct denials and both deny every tool', () => {
    expect(intersectToolAcl(real({ grants: { status: 'unavailable' } }))).toEqual({ status: 'denied', reason: 'grants_unavailable', tools: [] });
    expect(intersectToolAcl(real({ grants: { status: 'stale' } }))).toEqual({ status: 'denied', reason: 'grants_stale', tools: [] });
  });

  it('stale connector metadata removes only connector-backed tools, with its own degraded reason', () => {
    const r = intersectToolAcl(real({ connectors: { status: 'stale' } }));
    if (r.status !== 'admitted') throw new Error('expected admitted');
    expect(r.degraded).toBe('connectors_stale');
    expect(r.tools).toEqual(['read_artifact', 'export_artifact', 'read_mcp_tool', 'web_search']);
    expect(r.removed.map((x) => x.reason)).toEqual(['connector_unavailable', 'connector_unavailable', 'connector_unavailable']);
  });

  it('config and naming defects are reported as findings but do not remove a legitimate operation', () => {
    const r = intersectToolAcl(real({
      grants: { status: 'available', tools: [...installed, 'send_email'] },
      connector_backed: [...backed, 'search_connector'],
    }));
    if (r.status !== 'admitted') throw new Error('expected admitted');
    expect(r.tools).toEqual(installed);
    expect(r.findings).toEqual([
      { code: 'granted_tool_not_registered', tool: 'send_email' },
      { code: 'connector_backed_not_registered', tool: 'search_connector' },
    ]);
  });
});
