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
    expect(intersectToolAcl(base())).toEqual({ status: 'admitted', tools: pick(4) });
  });

  it('unavailable grants give the empty set with a closed reason, never a default-allow', () => {
    expect(intersectToolAcl(base({ grants: { status: 'unavailable' } }))).toEqual({ status: 'denied', reason: 'grants_unavailable', tools: [] });
  });

  it('unavailable connectors remove every connector-backed tool and keep the rest', () => {
    const backed = pick(2);
    const result = intersectToolAcl(base({ connectors: { status: 'unavailable' }, connector_backed: backed }));
    expect(result).toEqual({ status: 'admitted', tools: pick(4).filter((t) => !backed.includes(t)), degraded: 'connectors_unavailable' });
  });

  it('a tool missing from grants, handlers or the trigger is removed; the result is never wider than any input', () => {
    const narrowGrants = intersectToolAcl(base({ grants: { status: 'available', tools: pick(2) } }));
    expect(narrowGrants).toEqual({ status: 'admitted', tools: pick(2) });
    const narrowHandlers = intersectToolAcl(base({ handlers: pick(1) }));
    expect(narrowHandlers).toEqual({ status: 'admitted', tools: pick(1) });
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
    expect(intersectToolAcl(base({ grants: { status: 'available', tools: [] } }))).toEqual({ status: 'admitted', tools: [] });
  });

  it('output order and duplicates are deterministic', () => {
    const dup = [...pick(3), ...pick(3)];
    expect(intersectToolAcl(base({ handlers: dup, grants: { status: 'available', tools: [...dup].reverse() } })).tools).toEqual(pick(3));
  });
});
