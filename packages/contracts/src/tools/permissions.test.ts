// Owning ADRs: ADR-0008 (per-trigger ACL is the security boundary), ADR-0021 + amendment
// (canonical tool surface = the union, never a prose count), ADR-0039 (threading tools),
// ADR-0040 (query_calendar rename), ADR-0050 (execute_code in zero ACLs), ADR-0034
// (search_tools first-class + lazy discovery).
//
// Rejected framing (recorded, not encoded) — Option B: a bare 29-member union with
// search_tools deferred or implemented outside the canonical union. Option A ships per
// ADR-0034: search_tools is union member 30, granted in exactly user_message +
// handoff_explore, with the always-on set read_memory/send_message/propose_action/
// search_tools.
//
// Invariants under test: exact union membership + order; exact per-trigger ACL arrays;
// execute_code dispatchable nowhere; call_mcp_tool gated to user_message; no trigger gets
// the full surface; pre_activity_spot always carries send_message (ADR-0042); search_tools
// args bounds + default. Failure modes caught: a tool leaking into a forbidden trigger's
// ACL, a retired tool name resurfacing, blast-radius widening of brief, lazy discovery
// drifting beyond the two verbose triggers, an unbounded search_tools query or limit.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { triggerTypeSchema } from '../core/trigger';
import {
  ALWAYS_ON_TOOLS,
  LAZY_DISCOVERY_TRIGGERS,
  searchToolsArgsSchema,
  TOOL_PERMISSIONS,
  toolNameSchema,
} from './permissions';

const triggersGranting = (tool: string): readonly string[] =>
  triggerTypeSchema.options.filter((trigger) =>
    (TOOL_PERMISSIONS[trigger] as readonly string[]).includes(tool),
  );

describe('toolName', () => {
  it('is exactly the 30 canonical tools, in order', () => {
    expect(toolNameSchema.options).toEqual([
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
  });

  it("rejects the retired 'get_schedule' — renamed query_calendar (ADR-0040)", () => {
    expect(toolNameSchema.safeParse('get_schedule').success).toBe(false);
  });

  it("rejects a skill name — compositions are skills, not tools (ADR-0021)", () => {
    expect(toolNameSchema.safeParse('summarise_meeting').success).toBe(false);
  });
});

describe('TOOL_PERMISSIONS', () => {
  it('covers all 11 triggers and every entry is a canonical tool name', () => {
    expect(Object.keys(TOOL_PERMISSIONS).sort()).toEqual([...triggerTypeSchema.options].sort());
    for (const trigger of triggerTypeSchema.options) {
      expect(z.array(toolNameSchema).safeParse(TOOL_PERMISSIONS[trigger]).success).toBe(true);
    }
  });

  it('grants exactly the ADR-pinned ACL per trigger — any membership or order drift fails', () => {
    expect(TOOL_PERMISSIONS).toEqual({
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
      pre_activity_spot: [
        'get_crs',
        'query_calendar',
        'read_memory',
        'propose_schedule',
        'propose_action',
        'send_message',
      ],
    });
  });

  it('grants no trigger the full surface — user_message tops out at 29 of 30', () => {
    for (const trigger of triggerTypeSchema.options) {
      expect(TOOL_PERMISSIONS[trigger].length).toBeLessThan(toolNameSchema.options.length);
    }
    expect(TOOL_PERMISSIONS.user_message).toHaveLength(29);
  });

  it("keeps 'execute_code' typed but dispatchable nowhere (ADR-0050)", () => {
    expect(toolNameSchema.options).toContain('execute_code');
    expect(triggersGranting('execute_code')).toEqual([]);
  });

  it("grants 'call_mcp_tool' only in user_message — MCP is a gated bridge, not a bypass (ADR-0049)", () => {
    expect(triggersGranting('call_mcp_tool')).toEqual(['user_message']);
  });

  it("grants 'web_search' and 'read_document' only in the two verbose triggers", () => {
    for (const tool of ['web_search', 'read_document']) {
      expect(triggersGranting(tool)).toEqual(['handoff_explore', 'user_message']);
    }
  });

  it('grants the five threading tools in user_message only (ADR-0039)', () => {
    const threading = [
      'create_thread',
      'delete_message',
      'restore_message',
      'archive_thread',
      'update_thread_topics',
    ];
    for (const tool of threading) {
      expect(triggersGranting(tool)).toEqual(['user_message']);
    }
  });

  it("never grants brief 'execute_action' — injection has nowhere to go (ADR-0008)", () => {
    expect(TOOL_PERMISSIONS.brief).not.toContain('execute_action');
  });

  it("always grants pre_activity_spot 'send_message' — a Spot is never silent (ADR-0042)", () => {
    expect(TOOL_PERMISSIONS.pre_activity_spot).toContain('send_message');
  });
});

describe('search_tools — ADR-0034 Option A, first-class', () => {
  it('is granted in exactly the lazy-discovery triggers', () => {
    expect(triggersGranting('search_tools')).toEqual(['handoff_explore', 'user_message']);
    expect([...LAZY_DISCOVERY_TRIGGERS].sort()).toEqual(['handoff_explore', 'user_message']);
  });

  it('limits lazy discovery to the two verbose triggers, in the ADR-pinned order', () => {
    expect(LAZY_DISCOVERY_TRIGGERS).toEqual(['user_message', 'handoff_explore']);
  });

  it('pins the always-on set to exactly the ADR-0034 four, search_tools included', () => {
    expect(ALWAYS_ON_TOOLS).toEqual(['read_memory', 'send_message', 'propose_action', 'search_tools']);
  });

  it('keeps every always-on tool inside the user_message ACL — loading never widens permission', () => {
    for (const tool of ALWAYS_ON_TOOLS) {
      expect(TOOL_PERMISSIONS.user_message).toContain(tool);
    }
  });

  it('keeps the ACL authoritative on handoff_explore: always-on send_message/propose_action are not granted there', () => {
    expect(TOOL_PERMISSIONS.handoff_explore).not.toContain('send_message');
    expect(TOOL_PERMISSIONS.handoff_explore).not.toContain('propose_action');
  });
});

describe('searchToolsArgs', () => {
  const base = { query: 'draft an email to the team', limit: 2 };

  it('accepts a bounded query with an explicit limit', () => {
    expect(searchToolsArgsSchema.safeParse(base).success).toBe(true);
  });

  it('defaults limit to 3 when omitted', () => {
    expect(searchToolsArgsSchema.parse({ query: base.query })).toEqual({
      query: base.query,
      limit: 3,
    });
  });

  it('rejects an empty query (min 1)', () => {
    expect(searchToolsArgsSchema.safeParse({ ...base, query: '' }).success).toBe(false);
  });

  it('rejects a query over 200 chars (max 200)', () => {
    expect(searchToolsArgsSchema.safeParse({ ...base, query: 'q'.repeat(201) }).success).toBe(false);
  });

  it('rejects limit 0 (min 1)', () => {
    expect(searchToolsArgsSchema.safeParse({ ...base, limit: 0 }).success).toBe(false);
  });

  it('rejects limit 6 (max 5)', () => {
    expect(searchToolsArgsSchema.safeParse({ ...base, limit: 6 }).success).toBe(false);
  });

  it('rejects a fractional limit (int only)', () => {
    expect(searchToolsArgsSchema.safeParse({ ...base, limit: 2.5 }).success).toBe(false);
  });

  it('rejects an unknown extra key (strictObject)', () => {
    expect(searchToolsArgsSchema.safeParse({ ...base, offset: 1 }).success).toBe(false);
  });
});
