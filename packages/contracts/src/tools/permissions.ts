import { z } from 'zod';
import type { TriggerType } from '../core/trigger';

// Canonical tool-name union — single owner of the tool surface. Never assert a tool count
// in prose; derive it from this union (ADR-0021 amendment). Order is contract: reads 1-16,
// copilot writes + reclassified search_connector + deferred execute_code 17-24 (ADR-0021),
// threading 25-29 (ADR-0039), search_tools 30 (ADR-0034 first-class lazy discovery).
// 'query_calendar' is the ratified name (ADR-0040) — 'get_schedule' is drift.
// 'execute_code' stays typed while dispatchable nowhere (ADR-0050): eligibility is a
// TOOL_PERMISSIONS change, never a breaking type change.
export const toolNameSchema = z.enum([
  'get_crs',
  'get_health',
  'query_calendar',
  'get_communication',
  'get_tasks',
  'get_master_metrics',
  'get_context',
  'read_memory',
  'update_memory',
  'search_episodes',
  'propose_action',
  'execute_action',
  'send_message',
  'web_search',
  'read_document',
  'call_mcp_tool',
  'write_task',
  'update_task',
  'draft_document',
  'draft_email',
  'search_connector',
  'propose_schedule',
  'write_sheet_cell',
  'execute_code',
  'create_thread',
  'delete_message',
  'restore_message',
  'archive_thread',
  'update_thread_topics',
  'search_tools',
]);
export type ToolName = z.infer<typeof toolNameSchema>;

// The per-trigger ACL is the security boundary (ADR-0008): scoping cuts prompt cost and
// injection blast radius — a trigger without a permission gives injection nowhere to go.
// The deny-first check runs at PreToolUse priority 100 (ADR-0032) and is rebuilt from this
// map at every DO wake; no prior-session authorisation carries forward (ADR-0033).
export const TOOL_PERMISSIONS: Readonly<Record<TriggerType, readonly ToolName[]>> = {
  brief: [
    'get_crs',
    'get_health',
    'query_calendar',
    'get_communication',
    'get_tasks',
    'get_master_metrics',
    'get_context',
    'read_memory',
    'search_episodes',
    'search_connector',
    'propose_action',
    'send_message',
  ],
  fetch_alert: ['get_crs', 'get_health', 'read_memory', 'propose_action', 'send_message'],
  patrol: ['get_crs', 'get_health', 'read_memory', 'search_connector', 'propose_action'],
  pre_brief_sweep: [
    'get_crs',
    'get_health',
    'query_calendar',
    'get_communication',
    'get_tasks',
    'get_master_metrics',
    'get_context',
    'read_memory',
    'search_episodes',
    'search_connector',
  ],
  handoff_explore: [
    'get_crs',
    'get_health',
    'query_calendar',
    'get_communication',
    'get_tasks',
    'get_master_metrics',
    'get_context',
    'read_memory',
    'search_episodes',
    'search_connector',
    'web_search',
    'read_document',
    'search_tools',
  ],
  handoff_plan: ['get_crs', 'get_health', 'query_calendar', 'get_tasks', 'propose_action'],
  // The mutation cluster: execute_action + writes + send_message, reachable only after
  // explicit user approval through propose_action (ADR-0008).
  handoff_act: [
    'execute_action',
    'write_task',
    'update_task',
    'draft_document',
    'draft_email',
    'propose_schedule',
    'write_sheet_cell',
    'send_message',
  ],
  handoff_replan: [
    'get_crs',
    'get_health',
    'query_calendar',
    'get_tasks',
    'update_task',
    'propose_action',
  ],
  intervention: ['get_crs', 'get_health', 'read_memory', 'update_task', 'propose_action'],
  // Everything except execute_code (ADR-0050) — no trigger ever gets the full surface.
  user_message: [
    'get_crs',
    'get_health',
    'query_calendar',
    'get_communication',
    'get_tasks',
    'get_master_metrics',
    'get_context',
    'read_memory',
    'update_memory',
    'search_episodes',
    'search_connector',
    'web_search',
    'read_document',
    'call_mcp_tool',
    'write_task',
    'update_task',
    'draft_document',
    'draft_email',
    'propose_schedule',
    'write_sheet_cell',
    'propose_action',
    'execute_action',
    'send_message',
    'create_thread',
    'delete_message',
    'restore_message',
    'archive_thread',
    'update_thread_topics',
    'search_tools',
  ],
  dreaming_mode: ['read_memory', 'update_memory', 'search_episodes'],
  // Always carries send_message — a Spot is never silent (ADR-0042).
  pre_activity_spot: [
    'get_crs',
    'query_calendar',
    'read_memory',
    'propose_schedule',
    'propose_action',
    'send_message',
  ],
  // Outcome-bound candidate planning has no inherited capabilities. Provider text can propose
  // steps, but cannot discover or invoke any tool through this trigger.
  work_unit_plan: [],
};

// ADR-0034 lazy discovery: on the verbose triggers the prompt builder loads only the
// always-on set and the model discovers the rest via search_tools; narrow ACLs stay
// full-load — discovery overhead beats the benefit below ~10 tools.
export const LAZY_DISCOVERY_TRIGGERS: readonly TriggerType[] = ['user_message', 'handoff_explore'];

// Loaded even in lazy mode (ADR-0034). The ACL stays authoritative deny-first (ADR-0008):
// handoff_explore grants neither send_message nor propose_action, so the loadable set
// there is this list ∩ the ACL — loading never widens permission.
export const ALWAYS_ON_TOOLS: readonly ToolName[] = [
  'read_memory',
  'send_message',
  'propose_action',
  'search_tools',
];

// search_tools returns top-K by query relevance only — "show me everything" is
// unrepresentable, which is what keeps lazy loading lazy (ADR-0034). Read-only, not
// autonomy-gated; its trigger allowlist is exactly LAZY_DISCOVERY_TRIGGERS.
export const searchToolsArgsSchema = z.strictObject({
  query: z.string().min(1).max(200),
  limit: z.int().min(1).max(5).default(3),
});
export type SearchToolsArgs = z.infer<typeof searchToolsArgsSchema>;
