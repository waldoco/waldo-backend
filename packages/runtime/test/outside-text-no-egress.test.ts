import { describe, expect, it } from 'vitest';
import { CHECK_BACK_TOOLS, LOOP_CHECK_BACK_TOOLS, OUTSIDE_TEXT_JOB_TOOLS } from '../src/channels/check-back';
import { updateSweepTools } from '../src/channels/update-sweep';
import { CHILD_READ_TOOLS } from '../src/conversation/subagent';
import { EGRESS_READ_TOOLS, MACHINE_READER } from '../src/tasks/profiles';

// An unattended turn that starts on someone else's text could be steered into putting the owner's private data in a
// search query or an MCP call; nothing cards a read, so those turns must not hold the reads that send text out.
describe('unattended turns on outside text hold no egress reads', () => {
  it('names the egress reads once: web search and MCP reads', () => {
    expect([...EGRESS_READ_TOOLS].sort()).toEqual(['read_mcp_tool', 'web_search']);
    for (const name of EGRESS_READ_TOOLS) expect(MACHINE_READER).not.toContain(name);
  });

  it.each([
    ['a loop check-back', LOOP_CHECK_BACK_TOOLS],
    ['an outside-text job', OUTSIDE_TEXT_JOB_TOOLS],
    ['an update sweep apply', updateSweepTools(false)],
    ['an update sweep apply with source follow-ups', updateSweepTools(true)],
  ])('%s', (_name, tools) => {
    for (const name of EGRESS_READ_TOOLS) expect(tools).not.toContain(name);
  });

  it('keeps every other read, so the jobs can still look before they write', () => {
    const reads = CHILD_READ_TOOLS.filter((name) => !EGRESS_READ_TOOLS.includes(name));
    expect(reads).toEqual(expect.arrayContaining(['read_thread', 'query_calendar', 'read_memory']));
    expect(OUTSIDE_TEXT_JOB_TOOLS).toEqual([...reads, 'propose_action']);
    expect(LOOP_CHECK_BACK_TOOLS).toEqual([...reads, 'close_loop', 'propose_action']);
  });

  it('leaves the reminder check-back, which starts on the owner\'s own words, with every child read', () => {
    expect(CHECK_BACK_TOOLS).toEqual(CHILD_READ_TOOLS);
  });
});
