import type { TriggerType } from '../core/trigger';
import { TOOL_PERMISSIONS, type ToolName } from './permissions';

// Admitted tool set for one invocation: handlers registered in the host, intersected with the
// trigger's static permissions and the owner's current grants. Fail closed on missing grant metadata
// (no default-allow), but never silently: every removed tool carries a closed reason, and config or naming
// defects are reported as findings without removing a legitimate installed + granted operation.
export type ToolAclSource = Readonly<{ status: 'available'; tools: readonly ToolName[] } | { status: 'unavailable' } | { status: 'stale' }>;

export type ToolAclInput = Readonly<{
  trigger: TriggerType;
  // The registered handlers are the authority for what is installed.
  handlers: readonly ToolName[];
  grants: ToolAclSource;
  connectors: ToolAclSource;
  // Tools that need a live connector. No central table exists yet; see the design note for the
  // proposed handler-declared source. Names here that are not registered are reported as findings.
  connector_backed: readonly ToolName[];
}>;

export type ToolAclRemovalReason = 'not_in_trigger' | 'not_granted' | 'connector_unavailable' | 'connector_not_listed';
export type ToolAclFinding = Readonly<{ code: 'granted_tool_not_registered' | 'connector_backed_not_registered'; tool: ToolName }>;

export type ToolAclResult =
  | Readonly<{
    status: 'admitted';
    tools: readonly ToolName[];
    removed: readonly Readonly<{ tool: ToolName; reason: ToolAclRemovalReason }>[];
    findings: readonly ToolAclFinding[];
    degraded?: 'connectors_unavailable' | 'connectors_stale';
  }>
  | Readonly<{ status: 'denied'; reason: 'grants_unavailable' | 'grants_stale'; tools: readonly [] }>;

export function intersectToolAcl(input: ToolAclInput): ToolAclResult {
  if (input.grants.status === 'unavailable') return { status: 'denied', reason: 'grants_unavailable', tools: [] };
  if (input.grants.status === 'stale') return { status: 'denied', reason: 'grants_stale', tools: [] };
  const permitted = new Set<ToolName>(TOOL_PERMISSIONS[input.trigger]);
  const granted = new Set<ToolName>(input.grants.tools);
  const backed = new Set<ToolName>(input.connector_backed);
  const connected = input.connectors.status === 'available' ? new Set<ToolName>(input.connectors.tools) : null;
  const registered = new Set<ToolName>(input.handlers);
  const seen = new Set<ToolName>();
  const tools: ToolName[] = [];
  const removed: Array<{ tool: ToolName; reason: ToolAclRemovalReason }> = [];
  for (const name of input.handlers) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (!permitted.has(name)) { removed.push({ tool: name, reason: 'not_in_trigger' }); continue; }
    if (!granted.has(name)) { removed.push({ tool: name, reason: 'not_granted' }); continue; }
    if (backed.has(name)) {
      if (connected === null) { removed.push({ tool: name, reason: 'connector_unavailable' }); continue; }
      if (!connected.has(name)) { removed.push({ tool: name, reason: 'connector_not_listed' }); continue; }
    }
    tools.push(name);
  }
  const findings: ToolAclFinding[] = [];
  for (const tool of new Set(input.grants.tools)) if (!registered.has(tool)) findings.push({ code: 'granted_tool_not_registered', tool });
  for (const tool of new Set(input.connector_backed)) if (!registered.has(tool)) findings.push({ code: 'connector_backed_not_registered', tool });
  const degraded = input.connectors.status !== 'available' && input.connector_backed.length > 0
    ? (input.connectors.status === 'stale' ? 'connectors_stale' as const : 'connectors_unavailable' as const)
    : undefined;
  return degraded === undefined ? { status: 'admitted', tools, removed, findings } : { status: 'admitted', tools, removed, findings, degraded };
}

// Derives the connector-backed tool names from handler declarations. A handler that omits the flag is not connector-backed,
// so the flag lives on the handler next to its Google call, not in a separate host list.
export const connectorBackedTools = (handlers: readonly Readonly<{ name: ToolName; requires_connector?: true }>[]): ToolName[] =>
  [...new Set(handlers.filter((h) => h.requires_connector === true).map((h) => h.name))].sort();
