import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import {
  callMcpToolArgsSchema,
  callMcpToolResultSchema,
  executeActionArgsSchema,
  getCommunicationArgsSchema,
  getContextArgsSchema,
  getCrsArgsSchema,
  getHealthArgsSchema,
  getMasterMetricsArgsSchema,
  getTasksArgsSchema,
  healthMetricSelectorSchema,
  queryCalendarArgsSchema,
  readDocumentArgsSchema,
  readDocumentResultSchema,
  readMemoryArgsSchema,
  searchEpisodesArgsSchema,
  taskStatusFilterSchema,
  browsePageArgsSchema,
  webSearchArgsSchema,
  webSearchResultSchema,
} from './reads';

// Owning ADRs: ADR-0049 (general-agent tools + taint gate), ADR-0029 (valid + invalid pair
// per tool schema), ADR-0008/0021 (read-cluster surface), ADR-0025 ('r2_scratch'
// provider vocabulary). search_tools lives with tools/permissions because its contract is
// inseparable from the canonical tool union, ACL, lazy triggers, and always-on set.
// Invariants under test: strictObject rejection of smuggled args, pinned defaults, and
// external-origin results unrepresentable untainted. Failure modes caught: enum drift,
// loosened bounds, a taint field gone nullable, and provider vocabulary re-declared away
// from its single owner.

describe('getCrsArgs', () => {
  it('defaults range_days to 1', () => {
    expect(getCrsArgsSchema.parse({})).toEqual({ range_days: 1 });
  });

  it('rejects range_days outside 1-90', () => {
    expect(getCrsArgsSchema.safeParse({ range_days: 0 }).success).toBe(false);
    expect(getCrsArgsSchema.safeParse({ range_days: 91 }).success).toBe(false);
  });

  it('rejects a smuggled extra argument', () => {
    expect(getCrsArgsSchema.safeParse({ range_days: 1, verbose: true }).success).toBe(false);
  });
});

describe('healthMetricSelector', () => {
  it('is exactly the six selectors, in order', () => {
    expect(healthMetricSelectorSchema.options).toEqual([
      'hrv',
      'hr',
      'sleep',
      'spo2',
      'strain',
      'recovery',
    ]);
  });

  it('accepts a selector list and rejects an out-of-domain metric', () => {
    expect(getHealthArgsSchema.safeParse({ metrics: ['hrv', 'sleep'] }).success).toBe(true);
    expect(getHealthArgsSchema.safeParse({ metrics: ['glucose'] }).success).toBe(false);
  });
});

describe('queryCalendarArgs', () => {
  it('defaults include_declined false and limit 20', () => {
    expect(queryCalendarArgsSchema.parse({})).toEqual({ include_declined: false, limit: 20 });
  });

  it('rejects a date_range that ends before it starts', () => {
    expect(
      queryCalendarArgsSchema.safeParse({
        date_range: { from: '2026-01-02T00:00:00Z', to: '2026-01-01T00:00:00Z' },
      }).success,
    ).toBe(false);
  });

  it('rejects limit over 50', () => {
    expect(queryCalendarArgsSchema.safeParse({ limit: 51 }).success).toBe(false);
  });
});

describe('getCommunicationArgs', () => {
  it('accepts an empty call and a well-ordered range', () => {
    expect(getCommunicationArgsSchema.safeParse({}).success).toBe(true);
    expect(
      getCommunicationArgsSchema.safeParse({
        date_range: { from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' },
      }).success,
    ).toBe(true);
  });

  it('rejects a smuggled extra argument', () => {
    expect(getCommunicationArgsSchema.safeParse({ raw: true }).success).toBe(false);
  });
});

describe('taskStatusFilter / getTasksArgs', () => {
  it('is exactly the three states plus the all sentinel, in order', () => {
    expect(taskStatusFilterSchema.options).toEqual(['todo', 'in_progress', 'done', 'all']);
  });

  it("defaults status 'todo' and limit 20", () => {
    expect(getTasksArgsSchema.parse({})).toEqual({ status: 'todo', limit: 20 });
  });

  it('rejects an out-of-domain status and limit over 100', () => {
    expect(getTasksArgsSchema.safeParse({ status: 'blocked' }).success).toBe(false);
    expect(getTasksArgsSchema.safeParse({ limit: 101 }).success).toBe(false);
  });
});

describe('getMasterMetricsArgs', () => {
  it('accepts an empty call and an ISO date', () => {
    expect(getMasterMetricsArgsSchema.safeParse({}).success).toBe(true);
    expect(getMasterMetricsArgsSchema.safeParse({ date: '2026-01-01T00:00:00Z' }).success).toBe(
      true,
    );
  });

  it('rejects a non-ISO date', () => {
    expect(getMasterMetricsArgsSchema.safeParse({ date: 'yesterday' }).success).toBe(false);
  });
});

describe('getContextArgs', () => {
  it('accepts an empty call and a bounded topic', () => {
    expect(getContextArgsSchema.safeParse({}).success).toBe(true);
    expect(getContextArgsSchema.safeParse({ topic: 'board prep' }).success).toBe(true);
  });

  it('rejects an empty topic and a topic over 200 chars', () => {
    expect(getContextArgsSchema.safeParse({ topic: '' }).success).toBe(false);
    expect(getContextArgsSchema.safeParse({ topic: 'x'.repeat(201) }).success).toBe(false);
  });
});

describe('readMemoryArgs', () => {
  it("reads span all five halls — 'facts' is readable", () => {
    expect(readMemoryArgsSchema.safeParse({ hall: 'facts' }).success).toBe(true);
  });

  it('defaults limit to 10', () => {
    expect(readMemoryArgsSchema.parse({})).toEqual({ limit: 10 });
  });

  it('rejects a non-hall and a query over 500 chars', () => {
    expect(readMemoryArgsSchema.safeParse({ hall: 'goals' }).success).toBe(false);
    expect(readMemoryArgsSchema.safeParse({ query: 'x'.repeat(501) }).success).toBe(false);
  });
});

describe('searchEpisodesArgs', () => {
  it('defaults limit to 5', () => {
    expect(searchEpisodesArgsSchema.parse({ query: 'travel week' })).toEqual({
      query: 'travel week',
      limit: 5,
    });
  });

  it('rejects an empty query and limit over 20', () => {
    expect(searchEpisodesArgsSchema.safeParse({ query: '' }).success).toBe(false);
    expect(searchEpisodesArgsSchema.safeParse({ query: 'q', limit: 21 }).success).toBe(false);
  });
});

describe('executeActionArgs', () => {
  const base = { action_id: 'act-1', confirmation_token: 'tok-1' };

  it('accepts a confirmed action reference', () => {
    expect(executeActionArgsSchema.safeParse(base).success).toBe(true);
  });

  it('rejects execution without the confirmation token', () => {
    const { confirmation_token: _dropped, ...rest } = base;
    expect(executeActionArgsSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects a model-supplied user_id (identity comes from trusted context)', () => {
    expect(executeActionArgsSchema.safeParse({ ...base, user_id: 'user-1' }).success).toBe(false);
  });
});

describe('browsePageArgs', () => {
  it('accepts a url + instruction and rejects extras, empty instruction and non-urls', () => {
    expect(browsePageArgsSchema.parse({ url: 'https://example.com', instruction: 'what is on this page' })).toEqual({
      url: 'https://example.com', instruction: 'what is on this page',
    });
    expect(browsePageArgsSchema.safeParse({ url: 'not a url', instruction: 'x' }).success).toBe(false);
    expect(browsePageArgsSchema.safeParse({ url: 'https://example.com', instruction: '' }).success).toBe(false);
    expect(browsePageArgsSchema.safeParse({ url: 'https://example.com', instruction: 'x', act: 'click' }).success).toBe(false);
  });
});

describe('webSearchArgs', () => {
  it('defaults limit to 5', () => {
    expect(webSearchArgsSchema.parse({ query: 'jet lag protocols' })).toEqual({
      query: 'jet lag protocols',
      limit: 5,
    });
  });

  it('rejects an empty query and limit over 10', () => {
    expect(webSearchArgsSchema.safeParse({ query: '' }).success).toBe(false);
    expect(webSearchArgsSchema.safeParse({ query: 'q', limit: 11 }).success).toBe(false);
  });
});

describe('readDocumentArgs', () => {
  it("accepts the 'r2_scratch' provider literal", () => {
    expect(
      readDocumentArgsSchema.safeParse({ doc_id: 'doc-1', provider: 'r2_scratch' }).success,
    ).toBe(true);
  });

  it("rejects the bare 'scratch' drift literal", () => {
    expect(
      readDocumentArgsSchema.safeParse({ doc_id: 'doc-1', provider: 'scratch' }).success,
    ).toBe(false);
  });

  it('rejects an empty doc_id', () => {
    expect(readDocumentArgsSchema.safeParse({ doc_id: '' }).success).toBe(false);
  });
});

describe('callMcpToolArgs', () => {
  const base = { server: 'linear', tool: 'create_issue', args: { title: 'follow up' } };

  it('accepts a well-formed bridge call', () => {
    expect(callMcpToolArgsSchema.safeParse(base).success).toBe(true);
  });

  it('rejects an empty server and non-record args', () => {
    expect(callMcpToolArgsSchema.safeParse({ ...base, server: '' }).success).toBe(false);
    expect(callMcpToolArgsSchema.safeParse({ ...base, args: 'not-a-record' }).success).toBe(false);
  });
});

describe('external-origin results carry taint (ADR-0049)', () => {
  const hit = { title: 'Jet lag study', url: 'https://example.com/study', snippet: 'summary' };

  it("accepts a web search result stamped 'external'", () => {
    expect(
      webSearchResultSchema.safeParse({ hits: [hit], source_taint: 'external' }).success,
    ).toBe(true);
  });

  it('rejects an untainted (null) web search result — unrepresentable, not merely checked', () => {
    expect(webSearchResultSchema.safeParse({ hits: [hit], source_taint: null }).success).toBe(
      false,
    );
  });

  it('rejects a web search result missing the taint field entirely', () => {
    expect(webSearchResultSchema.safeParse({ hits: [hit] }).success).toBe(false);
  });

  const baseDocRead = {
    doc_id: 'doc-1',
    title: 'Weekly plan',
    body_markdown: '# plan',
    url: 'https://example.com/doc-1',
    date_modified: '2026-01-01T00:00:00Z',
    size_bytes: 128,
    source_taint: 'external',
  } as const;

  it('accepts a tainted document read riding the DocAdapter shape', () => {
    expect(readDocumentResultSchema.safeParse(baseDocRead).success).toBe(true);
  });

  it('rejects an untainted document read', () => {
    expect(
      readDocumentResultSchema.safeParse({ ...baseDocRead, source_taint: null }).success,
    ).toBe(false);
  });

  it('accepts tainted MCP output and rejects a result with no output payload', () => {
    expect(
      callMcpToolResultSchema.safeParse({ output: { issue_id: 'LIN-1' }, source_taint: 'external' })
        .success,
    ).toBe(true);
    expect(callMcpToolResultSchema.safeParse({ source_taint: 'external' }).success).toBe(false);
  });

  it("rejects a taint value outside the owner's vocabulary", () => {
    expect(
      callMcpToolResultSchema.safeParse({ output: {}, source_taint: 'internal' }).success,
    ).toBe(false);
  });
});

describe('date_range guidance and strictness', () => {
  it('rejects the exact live-failure args: minute precision without seconds or offset', () => {
    expect(
      queryCalendarArgsSchema.safeParse({ date_range: { from: '2026-09-26T00:00', to: '2026-09-26T23:59' } }).success,
    ).toBe(false);
  });

  it('tells the model the required format in the advertised JSON schema', () => {
    const json = z.toJSONSchema(queryCalendarArgsSchema, { io: 'input' }) as {
      properties?: { date_range?: { properties?: { from?: { description?: string } } } };
    };
    const description = json.properties?.date_range?.properties?.from?.description ?? '';
    expect(description).toContain('seconds');
    expect(description).toContain('offset');
    expect(description).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});
