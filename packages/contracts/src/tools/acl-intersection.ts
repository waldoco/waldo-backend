import type { TriggerType } from '../core/trigger';
import { TOOL_PERMISSIONS, type ToolName } from './permissions';

// Admitted tool set for one invocation: handlers registered in the host, intersected with the
// trigger's static permissions and the owner's current grants. Fail closed: a source that is not
// available never widens the set. There is no default-allow and no fallback to the static list.
export type ToolAclSource = Readonly<{ status: 'available'; tools: readonly ToolName[] } | { status: 'unavailable' }>;

export type ToolAclInput = Readonly<{
  trigger: TriggerType;
  handlers: readonly ToolName[];
  grants: ToolAclSource;
  connectors: ToolAclSource;
  // Tools that need a live connector. The host supplies this list; unavailable connector state removes them.
  connector_backed: readonly ToolName[];
}>;

export type ToolAclResult =
  | Readonly<{ status: 'admitted'; tools: readonly ToolName[]; degraded?: 'connectors_unavailable' }>
  | Readonly<{ status: 'denied'; reason: 'grants_unavailable'; tools: readonly [] }>;

export function intersectToolAcl(input: ToolAclInput): ToolAclResult {
  if (input.grants.status === 'unavailable') return { status: 'denied', reason: 'grants_unavailable', tools: [] };
  const permitted = new Set<ToolName>(TOOL_PERMISSIONS[input.trigger]);
  const granted = new Set<ToolName>(input.grants.tools);
  const backed = new Set<ToolName>(input.connector_backed);
  const connected = input.connectors.status === 'available' ? new Set<ToolName>(input.connectors.tools) : null;
  const seen = new Set<ToolName>();
  const tools: ToolName[] = [];
  for (const name of input.handlers) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (!permitted.has(name) || !granted.has(name)) continue;
    if (backed.has(name) && (connected === null || !connected.has(name))) continue;
    tools.push(name);
  }
  return connected === null && input.connector_backed.length > 0
    ? { status: 'admitted', tools, degraded: 'connectors_unavailable' }
    : { status: 'admitted', tools };
}
